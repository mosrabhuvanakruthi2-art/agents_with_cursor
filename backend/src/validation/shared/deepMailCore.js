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
  compareSensitivityOutlookToOutlook,
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

/**
 * Extract the set of URLs that are CLICKABLE hyperlinks (inside <a href="...">) in an HTML body.
 * Plain-text URLs are ignored — a URL is only "clickable" if it is wrapped in an anchor tag.
 */
function extractAnchorHrefs(html) {
  if (!html) return [];
  const out = [];
  const rx = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const url = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (/^(https?:\/\/|mailto:)/i.test(url)) out.push(url);
  }
  return out;
}

/** Normalise a URL for loose equality: strip angle brackets, trailing punctuation, trailing slash, lowercase. */
function normalizeLinkForCompare(u) {
  return String(u || '')
    .trim()
    .replace(/^<+|>+$/g, '')
    .replace(/[.,;:!?)]+$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Clickable-link preservation (applies to ALL combinations).
 * Every hyperlink that is clickable (<a href>) in the SOURCE body must also be clickable in the
 * DESTINATION body. If a source hyperlink is flattened to plain text (or dropped) at the destination,
 * recipients can no longer click it — reported as an error so validation files it as a bug.
 *
 * IMPORTANT: both arguments must be RAW HTML bodies (with anchor tags), not plain-text-normalised
 * bodies — flattening to plain text removes the <a> tags this check relies on.
 */
function compareClickableLinks(srcHtml, dstHtml) {
  const srcAnchors = extractAnchorHrefs(srcHtml);
  if (srcAnchors.length === 0) return [];
  const stripQuery = (s) => s.replace(/[?#].*$/, '');
  const dstAnchorsNorm = extractAnchorHrefs(dstHtml).map(normalizeLinkForCompare).filter(Boolean);
  const dstAnchorSet = new Set(dstAnchorsNorm);
  const dstAnchorSetNoQuery = new Set(dstAnchorsNorm.map(stripQuery));
  const dstTextLower = String(dstHtml || '').toLowerCase();
  const diffs = [];
  const seen = new Set();
  for (const rawUrl of srcAnchors) {
    const norm = normalizeLinkForCompare(rawUrl);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const clickableAtDest = dstAnchorSet.has(norm) || dstAnchorSetNoQuery.has(stripQuery(norm));
    if (clickableAtDest) continue;
    const presentAsText =
      dstTextLower.includes(norm) || dstTextLower.includes(String(rawUrl).toLowerCase());
    diffs.push({
      field: 'clickableLink',
      ok: false,
      expected: `Clickable hyperlink: ${rawUrl}`,
      actual: presentAsText
        ? 'Present as plain text only — no longer clickable'
        : 'Missing from destination',
      displaySource: `${rawUrl} (clickable link)`,
      displayDestination: presentAsText ? `${rawUrl} (plain text — not clickable)` : 'Missing',
      severity: 'error',
      note: presentAsText
        ? 'A hyperlink that was clickable at the source lost its <a href> anchor during migration and is now plain text, so recipients cannot click it.'
        : 'A hyperlink present and clickable at the source is missing from the destination body.',
    });
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
  if (d === 'no-match-in-dest-index') {
    const n = resolved.scannedMessages ?? scanMax;
    return `No destination with matching Message-ID in the one-time destination index (${n} messages scanned once). Message-ID was likely rewritten during migration; a subject+time fallback is attempted next.`;
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
    if (attExceedsHashCap(att, null, hashMax, 'G→O src', log)) continue;
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
    if (attExceedsHashCap(g, null, hashMax, 'G→O dst', log)) continue;
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
 * True if an attachment is larger than the byte-hash cap — in which case we SKIP the download
 * (it would just be aborted by maxContentLength after wasting time) and log it as an expected
 * skip rather than a scary "read failed" warning. Size mismatch is still caught by Tier A/size.
 */
function attExceedsHashCap(att, meta, hashMax, tag, log) {
  const size = Number(att?.size || meta?.size || 0);
  if (size > hashMax) {
    log.info(
      `Tier B (${tag}): skipping byte-hash for "${att.filename}" ` +
      `(${(size / 1048576).toFixed(1)} MB > ${(hashMax / 1048576).toFixed(0)} MB cap) — size compared separately`
    );
    return true;
  }
  return false;
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
    if (attExceedsHashCap(att, meta, hashMax, 'O→O src', log)) continue;
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
    if (attExceedsHashCap(att, meta, hashMax, 'O→O dst', log)) continue;
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
    if (attExceedsHashCap(att, meta, hashMax, 'O→G', log)) continue;
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
 *
 * Two groups:
 *   1. System/meta folders that never hold user mail (outbox, sync issues, recoverable items…).
 *   2. KNOWN MIGRATION LIMITATIONS — folders whose messages CloudFuze does NOT migrate to the
 *      destination. Scanning them would produce false "missing at destination" errors, so they
 *      are excluded from source scanning:
 *        • Conversation History  — messages do not migrate
 *        • Notes                 — messages do not migrate
 *        • RSS Feeds             — folder may be re-created at destination but messages do not migrate
 *        • Search Folders        — messages do not migrate (virtual folders)
 *   Drafts are also skipped: drafts lack a stable internetMessageId for reliable pairing.
 */
const OUTLOOK_SKIP_SCAN_FOLDERS = new Set([
  'drafts',
  'outbox',
  'conversation history', // migration limitation: messages do not migrate
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
  'rss feeds',            // migration limitation: folder may be created, messages do not migrate
  'rss subscriptions',    // migration limitation: folder may be created, messages do not migrate
  'clutter',
  'search folders',       // migration limitation: messages do not migrate (virtual folders)
  'quick step settings',
  'calendar',
  'contacts',
  'tasks',
  'journal',
  'notes',                // migration limitation: messages do not migrate
]);

/**
 * Collect QA-tagged messages from all scannable Outlook folders for the source mailbox.
 * Scans every non-system folder (Inbox, Sent Items, Junk, Deleted Items, Archive, custom…)
 * so deep validation covers the full seeded set, not just Inbox.
 */
async function collectOutlookQaCandidates(srcUser, maxMessages, subjectPrefix, selectFields, log, extraSkipFolders = []) {
  const folders = await outlookClient.getAllFoldersFlat(srcUser);
  if (!folders?.length) return [];

  // Folders to skip: the always-skip set plus any caller-supplied extras (e.g. "archive" when
  // the Archive Mailbox option is OFF, so archived mail isn't scanned or flagged as not-migrated).
  const skip = new Set([
    ...OUTLOOK_SKIP_SCAN_FOLDERS,
    ...extraSkipFolders.map((s) => String(s).toLowerCase()),
  ]);
  const scanFolders = folders.filter(
    (f) => f.id && !skip.has((f.displayName || '').toLowerCase())
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

// Gmail client-state labels — NOT folders. They must be excluded from FOLDER-placement checks so
// that e.g. "INBOX | UNREAD" doesn't show UNREAD in a folder diff (read state is validated separately).
const GMAIL_CLIENT_STATE_LABELS = new Set([
  'UNREAD', 'STARRED', 'IMPORTANT', 'CHAT',
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

function validateOutlookToGmailPlacement(outlookFolderPath, gmailLabelsStr, severity = 'error') {
  const folder = String(outlookFolderPath || '').toLowerCase().trim();
  // Keep only folder-like labels — drop UNREAD/STARRED/IMPORTANT/CATEGORY_* so placement compares
  // folders vs folders, and the displayed destination isn't cluttered with client-state labels.
  const folderLabels = parseGmailLabels(gmailLabelsStr).filter(
    (l) => !GMAIL_CLIENT_STATE_LABELS.has(String(l).toUpperCase().trim())
  );
  const folderLabelsStr = folderLabels.join(' | ') || '(no folder labels)';
  const labels = folderLabels.map((l) => l.toUpperCase());
  const expectedLabel = OUTLOOK_FOLDER_TO_GMAIL_LABEL.get(folder);

  // System folder check (case-insensitive for Archive[Gmail] which CloudFuze may create as Archive[GMAIL])
  if (expectedLabel) {
    const expectedUpper = expectedLabel.toUpperCase();
    if (labels.some((l) => l.toUpperCase() === expectedUpper)) return [];
    return [{
      field: 'folder',
      ok: false,
      expected: `Gmail label ${expectedLabel} (from Outlook: ${outlookFolderPath})`,
      actual: folderLabelsStr,
      displaySource: outlookFolderPath,
      displayDestination: folderLabelsStr,
      severity,
    }];
  }

  // Skip well-known non-mail or archive folders
  if (OUTLOOK_PLACEMENT_SKIP.has(folder) || !outlookFolderPath) return [];

  // Custom folder: check the leaf folder name appears in any Gmail label (case-insensitive)
  const rawPath = String(outlookFolderPath).trim();
  const leafName = rawPath.split('/').pop().trim().toLowerCase();
  if (!leafName) return [];
  const gmailLabelsLower = folderLabels.map((l) => l.toLowerCase().trim());
  const matched = gmailLabelsLower.some(
    (l) => l === leafName || l === rawPath.toLowerCase() || l.endsWith('/' + leafName)
  );
  if (matched) return [];
  return [{
    field: 'folder',
    ok: false,
    expected: `Gmail label containing "${rawPath}"`,
    actual: folderLabelsStr,
    displaySource: rawPath,
    displayDestination: folderLabelsStr,
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

        // Clickable-link preservation (O→G thread chain): compare RAW HTML anchors on both sides
        {
          const dstHtmlOG = gmailClient.extractHtmlBodyFromPayload(gmFull.payload) || '';
          diffs = diffs.concat(compareClickableLinks(omFull.body?.content || '', dstHtmlOG));
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
    //    Robust approach (mirrors the Gmail→Outlook thread-chain path): resolving each source
    //    message to a destination message BY internetMessageId fails in O→O because migration
    //    RE-STAMPS Message-IDs — replies then stay unpaired, get falsely reported as "missing",
    //    and their bodies are never compared. Instead we fetch the ENTIRE destination conversation
    //    once (any single paired/anchored message gives us its conversationId) and pair positionally.
    const scanMaxOO = intEnv('DEEP_VALIDATION_SCAN_MAX', 3000);
    const sortByDstTime = (arr) =>
      arr.sort((a, b) => {
        const ta = a.dstSentDateTime ? new Date(a.dstSentDateTime).getTime() : Infinity;
        const tb = b.dstSentDateTime ? new Date(b.dstSentDateTime).getTime() : Infinity;
        return ta - tb;
      });

    /** @type {{dstId:string, dstSentDateTime:(string|null), dstInternetMessageId:string}[]} */
    let dstSorted = [];
    let destConvId = null;

    // 2a. Find an anchor destination message id: prefer one the main loop already paired…
    let anchorDstId = null;
    for (const sm of srcMsgs) {
      const kd = knownDestIds.get(sm.id);
      if (kd) { anchorDstId = kd; break; }
    }
    // …otherwise resolve any source message (by Message-ID, then subject+time) to get a foothold.
    if (!anchorDstId) {
      for (const sm of srcMsgs) {
        const srcMid = sm.internetMessageId || '';
        if (srcMid) {
          try {
            const r = await outlookClient.resolveDestinationByInternetMessageId(destUser, srcMid, { maxScan: scanMaxOO });
            if (r.matches.length > 0) { anchorDstId = r.matches[0].id; break; }
          } catch (e) { log.warn(`Thread chain (O→O): anchor resolve for ${sm.id}: ${e.message}`); }
        }
        if (boolEnv('DEEP_VALIDATION_SUBJECT_TIME_FALLBACK', true)) {
          const normSub = normalizeSubject(sm.subject);
          const anchorMs = new Date(sm.sentDateTime || sm.receivedDateTime || 0).getTime();
          if (normSub && Number.isFinite(anchorMs)) {
            try {
              const fb = await outlookClient.findBestMessageBySubjectAndTime(
                destUser, normSub, anchorMs, intEnv('DEEP_VALIDATION_SUBJECT_TIME_WINDOW_MINUTES', 120), scanMaxOO
              );
              if (fb.match) { anchorDstId = fb.match.id; break; }
            } catch (e) { log.warn(`Thread chain (O→O): anchor subject+time for ${sm.id}: ${e.message}`); }
          }
        }
      }
    }

    // 2b. From the anchor, read its conversationId and fetch the WHOLE destination conversation.
    if (anchorDstId) {
      try {
        const anchorFull = await outlookClient.getMessageById(destUser, anchorDstId, 'id,conversationId');
        destConvId = anchorFull?.conversationId || null;
      } catch (e) {
        log.warn(`Thread chain (O→O): anchor conversationId fetch failed: ${e.message}`);
      }
    }
    if (destConvId) {
      try {
        const dc = await outlookClient.getConversationMessages(destUser, destConvId);
        if (dc.available && Array.isArray(dc.messages) && dc.messages.length > 0) {
          dstSorted = sortByDstTime(
            dc.messages.map((m) => ({
              dstId: m.id,
              dstSentDateTime: m.sentDateTime || null,
              dstInternetMessageId: m.internetMessageId || '',
            }))
          );
        } else if (!dc.available) {
          log.warn(`Thread chain (O→O): destination conversation ${destConvId}: ${dc.note}`);
        }
      } catch (e) {
        log.warn(`Thread chain (O→O): destination conversation ${destConvId} fetch failed: ${e.message}`);
      }
    }

    // 2c. Fallback: if the destination conversation could not be read, resolve each source message
    //     individually (original behaviour) so pairing never regresses to zero.
    if (dstSorted.length === 0) {
      const dstMsgSummaries = [];
      for (const sm of srcMsgs) {
        let dstId = knownDestIds.get(sm.id) || null;
        const srcMid = sm.internetMessageId || '';
        if (!dstId && srcMid) {
          try {
            const resolved = await outlookClient.resolveDestinationByInternetMessageId(destUser, srcMid, { maxScan: scanMaxOO });
            if (resolved.matches.length > 0) dstId = resolved.matches[0].id;
          } catch (e) { log.warn(`Thread chain (O→O): resolve dest for ${sm.id}: ${e.message}`); }
        }
        if (dstId) dstMsgSummaries.push({ dstId, dstSentDateTime: null, dstInternetMessageId: '' });
      }
      for (const entry of dstMsgSummaries) {
        try {
          const s = await outlookClient.getMessageById(destUser, entry.dstId, 'id,sentDateTime,internetMessageId');
          entry.dstSentDateTime = s.sentDateTime || null;
          entry.dstInternetMessageId = s.internetMessageId || '';
        } catch (e) { log.warn(`Thread chain (O→O): fetch dest summary ${entry.dstId}: ${e.message}`); }
      }
      dstSorted = sortByDstTime(dstMsgSummaries);
    }

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
        diffs = diffs.concat(compareSensitivityOutlookToOutlook(smFull.sensitivity, dmFull.sensitivity));

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
          // Clickable-link preservation: source hyperlinks must stay clickable at destination
          diffs = diffs.concat(compareClickableLinks(srcBodyRaw, dstBodyRaw));
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
 * Validate Gmail→Outlook thread chains using POSITIONAL PAIRING.
 *
 * For each Gmail threadId group with ≥1 paired destination entry:
 *   1. Detect thread splits: one Gmail threadId → multiple Outlook conversationIds
 *   2. Fetch the full Gmail thread (sorted by internalDate ASC)
 *   3. Fetch the primary Outlook conversation (sorted by sentDateTime ASC)
 *   4. Verify count match
 *   5. POSITIONAL PAIRING: Gmail[i] ↔ Outlook[i] — run full G→O Tier A/B/C
 *   6. UPDATE existing messageResults entries; ADD new ones for reply messages skipped by main scan
 *   7. Record results in result.deepMailValidation.threadChainResults
 *
 * opts: { tierC, tierB, tierAOpts }
 */
async function validateGmailToOutlookThreadChains(result, srcUser, destUser, log, opts = {}) {
  const {
    tierC = false,
    tierB = false,
    tierAOpts = {},
    archiveMailbox = true,
  } = opts;

  // Build gmailThreadId → { conversationIds: Set, pairedEntries: [], knownDestIds: Map }
  const threadMap = new Map();
  for (const entry of result.deepMailValidation.messageResults) {
    if (!entry._gmailThreadId) continue;
    if (!threadMap.has(entry._gmailThreadId)) {
      threadMap.set(entry._gmailThreadId, {
        conversationIds: new Set(),
        pairedEntries: [],
        knownDestIds: new Map(),
      });
    }
    const slot = threadMap.get(entry._gmailThreadId);
    slot.pairedEntries.push(entry);
    if (entry._conversationId) slot.conversationIds.add(entry._conversationId);
    if (entry.destMessageId) slot.knownDestIds.set(entry.sourceMessageId, entry.destMessageId);
  }

  const candidates = [...threadMap.entries()].filter(([, v]) => v.pairedEntries.length > 0);
  if (candidates.length === 0) return;

  result.deepMailValidation.threadChainResults = result.deepMailValidation.threadChainResults || [];
  log.info(`Thread chain validation (G→O): ${candidates.length} Gmail thread(s) to check`);

  // Fetch label map once for folder/placement comparisons
  let labelIdToName = new Map();
  try {
    const lbls = await gmailClient.listLabels(srcUser, 'me');
    labelIdToName = new Map((lbls || []).map((l) => [l.id, l.name]));
  } catch (e) {
    log.warn(`Thread chain (G→O): could not list Gmail labels: ${e.message}`);
  }

  const THREAD_BATCH = 10;
  const candidateEntries = [...candidates];

  for (let bi = 0; bi < candidateEntries.length; bi += THREAD_BATCH) {
    const batchResults = await Promise.all(
      candidateEntries.slice(bi, bi + THREAD_BATCH).map(async ([gmailThreadId, { conversationIds, pairedEntries, knownDestIds }]) => {

      // Pick most-common conversationId (handles occasional mismatched pairings)
      const convIdCounts = new Map();
      for (const cid of conversationIds) convIdCounts.set(cid, (convIdCounts.get(cid) || 0) + 1);
      const primaryConversationId = [...convIdCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      // 1. Fetch full Gmail thread (sorted oldest-first by internalDate)
      let gmailMsgs = [];
      let gmailAvailable = false;
      try {
        const gc = await gmailClient.getGmailThread(srcUser, gmailThreadId);
        gmailMsgs = gc.messages || [];
        gmailAvailable = gc.available;
        if (!gmailAvailable) log.warn(`Thread chain (G→O): Gmail thread ${gmailThreadId}: ${gc.note}`);
      } catch (e) {
        log.warn(`Thread chain (G→O): Gmail thread ${gmailThreadId} fetch failed: ${e.message}`);
      }
      gmailMsgs.sort((a, b) => (a.internalDate || 0) - (b.internalDate || 0));

      // 2. Fetch full Outlook conversation (sorted ASC by sentDateTime)
      let outlookMsgs = [];
      let outlookAvailable = false;
      if (primaryConversationId) {
        try {
          const oc = await outlookClient.getConversationMessages(destUser, primaryConversationId);
          outlookMsgs = oc.messages || [];
          outlookAvailable = oc.available;
          if (!outlookAvailable) log.warn(`Thread chain (G→O): Outlook conversation ${primaryConversationId}: ${oc.note}`);
        } catch (e) {
          log.warn(`Thread chain (G→O): Outlook conversation ${primaryConversationId} fetch failed: ${e.message}`);
        }
      }
      outlookMsgs.sort((a, b) => new Date(a.sentDateTime || 0) - new Date(b.sentDateTime || 0));

      const gmailCount = gmailMsgs.length || pairedEntries.length;
      const outlookCount = outlookMsgs.length;
      const mismatches = [];

      // 3a. Split thread: Gmail threadId maps to multiple Outlook conversationIds
      if (conversationIds.size > 1) {
        mismatches.push({
          field: 'threadSplit',
          ok: false,
          expected: '1 Outlook conversationId for the entire Gmail thread',
          actual: `${conversationIds.size} conversationId(s): ${[...conversationIds].join(', ')}`,
          displaySource: `Gmail threadId: ${gmailThreadId}`,
          displayDestination: `Split into: ${[...conversationIds].join(', ')}`,
          severity: 'error',
        });
      }

      // 3b. Message count mismatch
      if (gmailAvailable && outlookAvailable && gmailCount !== outlookCount) {
        const missing = gmailCount - outlookCount;
        mismatches.push({
          field: 'threadCount',
          ok: false,
          expected: `${gmailCount} message(s) in destination Outlook conversation`,
          actual: `${outlookCount} message(s) found in Outlook conversation`,
          displaySource: `Gmail: ${gmailCount} message(s)`,
          displayDestination: `Outlook: ${outlookCount} message(s)${missing > 0 ? ` — ${missing} missing` : ` — ${-missing} extra`}`,
          severity: 'error',
        });
      }

      // 4. POSITIONAL PAIRING: Gmail[i] ↔ Outlook[i]
      const messageComparisons = [];
      const scanMaxGO = intEnv('DEEP_VALIDATION_SCAN_MAX', 3000);

      if (gmailAvailable && outlookAvailable && gmailMsgs.length > 0 && outlookMsgs.length > 0) {
        const pairLen = Math.min(gmailMsgs.length, outlookMsgs.length);

        for (let i = 0; i < pairLen; i++) {
          const gmSummary = gmailMsgs[i];
          const omSummary = outlookMsgs[i];

          let gmFull = null;
          try {
            gmFull = await gmailClient.getMessageFullForValidation(srcUser, gmSummary.id);
          } catch (e) {
            log.warn(`Thread chain (G→O) pos ${i}: Gmail getMessageFullForValidation ${gmSummary.id} failed: ${e.message}`);
          }

          // Resolve Outlook message: prefer the known dest ID from the main loop,
          // fall back to the positional Outlook message from the conversation fetch
          let outlookMsgId = knownDestIds.get(gmSummary.id) || omSummary.id;
          let omFull = null;
          try {
            omFull = await outlookClient.getMessageById(destUser, outlookMsgId);
          } catch (e) {
            if (outlookMsgId !== omSummary.id) {
              try {
                omFull = await outlookClient.getMessageById(destUser, omSummary.id);
                outlookMsgId = omSummary.id;
              } catch (e2) {
                log.warn(`Thread chain (G→O) pos ${i}: Outlook getMessageById ${omSummary.id} failed: ${e2.message}`);
              }
            } else {
              log.warn(`Thread chain (G→O) pos ${i}: Outlook getMessageById ${outlookMsgId} failed: ${e.message}`);
            }
          }

          // Last resort: resolve by Gmail internetMessageId
          if (!omFull && gmFull?.internetMessageId) {
            try {
              const resolved = await outlookClient.resolveDestinationByInternetMessageId(destUser, gmFull.internetMessageId, { maxScan: scanMaxGO });
              if (resolved.matches.length > 0) {
                outlookMsgId = resolved.matches[0].id;
                omFull = await outlookClient.getMessageById(destUser, outlookMsgId);
              }
            } catch (e) {
              log.warn(`Thread chain (G→O) pos ${i}: internetMessageId resolution failed: ${e.message}`);
            }
          }

          if (!gmFull || !omFull) {
            messageComparisons.push({
              position: i, gmailId: gmSummary.id, outlookId: outlookMsgId || omSummary.id,
              pass: false, diffs: [], note: 'Failed to fetch full message content',
            });
            continue;
          }

          let graphAtt = [];
          try {
            graphAtt = await outlookClient.getAttachments(destUser, outlookMsgId);
          } catch (e) {
            log.warn(`Thread chain (G→O) pos ${i}: dest attachments for ${outlookMsgId}: ${e.message}`);
          }

          const sourceForTierA = {
            subject: gmFull.subject,
            from: gmFull.from,
            to: gmFull.to,
            cc: gmFull.cc,
            bcc: gmFull.bcc,
            replyTo: gmFull.replyTo || '',
            attachments: (gmFull.attachments || []).map((a) => ({ filename: a.filename, size: a.size })),
          };
          const destForTierA = {
            subject: omFull.subject,
            from: omFull.from,
            toRecipients: omFull.toRecipients,
            ccRecipients: omFull.ccRecipients,
            bccRecipients: omFull.bccRecipients,
            replyTo: omFull.replyTo,
            attachments: graphAttachmentsToCompareList(graphAtt),
          };

          let diffs = compareTierA(sourceForTierA, destForTierA, tierAOpts);
          diffs = diffs.concat(
            compareAttachmentSizesWithTolerance(sourceForTierA.attachments, destForTierA.attachments, 'gmail_to_outlook')
          );

          // Folder placement
          const srcFolderStr = gmailClient.formatGmailLabelsForCompare(gmFull.labelIds, labelIdToName);
          let dstFolderStr = '';
          if (omFull.parentFolderId) {
            try {
              dstFolderStr = await outlookClient.getMailFolderPathString(destUser, omFull.parentFolderId);
            } catch (e) {
              log.warn(`Thread chain (G→O) pos ${i}: dest folder path: ${e.message}`);
            }
          }
          const labelNames = parseGmailLabels(srcFolderStr);
          const folderSeverity = boolEnv('MAIL_DEEP_FOLDER_WARNING_ONLY', false) === true ? 'warning' : 'error';
          diffs = diffs.concat(
            validateGmailToOutlookPlacement({
              gmailLabels: labelNames,
              destFolderPath: dstFolderStr,
              destFlag: omFull.flag || null,
              destImportance: omFull.importance || null,
              options: { migrateOrphaned: false, archiveMailbox, severity: folderSeverity },
            })
          );

          diffs = diffs.concat(compareGmailUnreadToOutlookIsRead(gmFull.labelIds, omFull.isRead));
          {
            const toleranceMs = intEnv('DEEP_VALIDATION_SENT_TIME_TOLERANCE_MINUTES', 5) * 60000;
            diffs = diffs.concat(compareSentDateTime(gmFull.date, omFull.sentDateTime, toleranceMs));
          }

          // Tier C body (strip quoted lines for replies)
          if (tierC) {
            const srcHtml = gmailClient.extractHtmlBodyFromPayload(gmFull.payload);
            const bodyPlain = srcHtml
              ? htmlToPlainLoose(srcHtml)
              : gmailClient.extractPlainBodyFromPayload(gmFull.payload) || gmFull.snippet || '';
            const isReply = i > 0;
            const srcBodyNorm = normalizeMailBodyPlain(bodyPlain);
            const dstBodyRaw = omFull.body?.content || omFull.bodyPreview || '';
            const dstBodyNorm = normalizeMailBodyPlain(htmlToPlainLoose(dstBodyRaw) || dstBodyRaw);
            const srcBodyCmp = isReply ? stripQuotedLines(srcBodyNorm) : srcBodyNorm;
            const dstBodyCmp = isReply ? stripQuotedLines(dstBodyNorm) : dstBodyNorm;
            const bodyMax = intEnv('MAIL_DEEP_BODY_MAX_CHARS', 500000);
            diffs = diffs.concat(compareTierC(srcBodyCmp, dstBodyCmp, {
              bodyMismatchSeverity: 'error', maxChars: bodyMax,
              hasAttachments: (gmFull.attachments || []).length > 0,
              destHasAttachments: graphAtt.length > 0,
            }));
          }

          // Tier B attachment hash
          if (tierB && (gmFull.attachments || []).length > 0) {
            try {
              const { srcHashes, dstHashes } = await tierBHashesGmail(
                srcUser, gmFull, destUser, outlookMsgId, graphAtt, log
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
              log.warn(`Thread chain (G→O) pos ${i}: Tier B hash: ${e.message}`);
            }
          }

          const hasError = diffs.some((d) => d.severity === 'error');
          messageComparisons.push({
            position: i, gmailId: gmSummary.id, outlookId: outlookMsgId,
            subject: gmFull.subject || '', pass: !hasError, diffs,
          });

          // UPDATE existing entry (root/scanned message) with re-computed diffs,
          // or ADD a new entry for reply messages the main scan never visited
          const existingEntry = pairedEntries.find((e) => e.sourceMessageId === gmSummary.id);
          if (existingEntry) {
            const oldDestId = existingEntry.destMessageId;
            existingEntry.destMessageId = outlookMsgId;
            existingEntry._conversationId = omFull.conversationId || primaryConversationId;
            existingEntry.diffs = diffs;
            existingEntry.pass = !hasError;
            if (oldDestId && oldDestId !== outlookMsgId) {
              log.info(
                `Thread chain (G→O): corrected pairing pos ${i} "${gmFull.subject}": ` +
                `Outlook ${oldDestId} → ${outlookMsgId}`
              );
            }
          } else {
            result.addDeepMailMessageResult({
              sourceMessageId: gmSummary.id,
              internetMessageId: gmFull.internetMessageId || '',
              destMessageId: outlookMsgId,
              subject: gmFull.subject || gmSummary.subject || '',
              pass: !hasError, diffs,
              _gmailThreadId: gmailThreadId,
              _conversationId: omFull.conversationId || primaryConversationId,
              _threadPosition: i,
            });
          }
        }
      }

      const rootSubject = gmailMsgs[0]?.subject || pairedEntries[0]?.subject || '(unknown)';
      const structuralErrors = mismatches.filter((m) => m.severity === 'error').length;
      const pairErrors = messageComparisons.filter((mc) => !mc.pass).length;
      const pass = structuralErrors === 0 && pairErrors === 0;

      return {
        gmailThreadId,
        primaryConversationId,
        allConversationIds: [...conversationIds],
        rootSubject,
        gmailMessageCount: gmailCount,
        outlookMessageCount: outlookCount,
        countMatch: gmailCount === outlookCount,
        threadSplit: conversationIds.size > 1,
        pass,
        mismatches,
        messageComparisons,
        gmailSubjects: gmailMsgs.map((m) => m.subject),
        outlookSubjects: outlookMsgs.map((m) => m.subject),
      };
    }));

    for (const chainResult of batchResults) {
      result.deepMailValidation.threadChainResults.push(chainResult);
      if (!chainResult.pass) {
        const structuralErrors = chainResult.mismatches.filter((m) => m.severity === 'error').length;
        const pairErrors = chainResult.messageComparisons.filter((mc) => !mc.pass).length;
        log.warn(
          `Thread chain (G→O) FAIL: "${chainResult.rootSubject}" — Gmail=${chainResult.gmailMessageCount} Outlook=${chainResult.outlookMessageCount} ` +
          `split=${chainResult.threadSplit} structuralErrors=${structuralErrors} pairErrors=${pairErrors}`
        );
      }
    }
  }

  const failed = result.deepMailValidation.threadChainResults.filter((t) => !t.pass).length;
  const total = result.deepMailValidation.threadChainResults.length;
  if (total > 0) {
    log.info(`Thread chain validation (G→O) complete: ${total} thread(s) checked, ${failed} failed`);
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
    if (attExceedsHashCap(att, null, hashMax, 'G→G src', log)) continue;
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
    if (attExceedsHashCap(att, null, hashMax, 'G→G dst', log)) continue;
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

/**
 * Extract a trailing integer sequence number from an email subject.
 * "QA Custom - ProjectX Email 3"  → 3
 * "QA Custom - Email with Attachment" → null (no trailing number)
 */
function extractSubjectSequence(subject) {
  if (!subject) return null;
  const m = String(subject).trim().match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Compare the chronological order of paired messages at source vs destination — scoped PER FOLDER.
 *
 * Order is only meaningful within a folder/label (how mail is actually viewed); comparing across
 * folders — or across subject families that each restart numbering at "Email 1" — yields false
 * mismatches. So mails are grouped by source folder and, within each folder:
 *   - Expected order = sort by source timestamp, tiebroken by subject sequence number, then id.
 *   - Actual order   = sort by destination timestamp, with the SAME tiebreakers (so mails that are
 *     genuinely indistinguishable at the destination, e.g. identical dst time, are treated as
 *     in-order rather than flagged).
 *   - A mail is flagged only if its position within its folder differs between the two.
 *
 * Stores results in result.deepMailValidation.orderValidation — never throws.
 */
function validateMailOrderByTimestamp(result, log) {
  const all = result.deepMailValidation?.messageResults;
  if (!all || all.length < 2) {
    result.deepMailValidation.orderValidation = { skipped: true, reason: 'Fewer than 2 message results' };
    return;
  }

  const paired = all.filter(
    (r) =>
      r.destMessageId &&
      r._srcTimestampMs != null && Number.isFinite(Number(r._srcTimestampMs)) &&
      r._dstTimestampMs != null && Number.isFinite(Number(r._dstTimestampMs))
  );

  if (paired.length < 2) {
    result.deepMailValidation.orderValidation = {
      skipped: true,
      reason: `Fewer than 2 paired messages with timestamps (found ${paired.length})`,
    };
    return;
  }

  // Trailing sequence number ("… Email 3" → 3); messages without one sort last within a tie.
  const seqOf = (r) => {
    const s = extractSubjectSequence(r.subject);
    return s == null ? Number.POSITIVE_INFINITY : s;
  };
  const folderKeyOf = (r) => String(r._srcFolder || '').trim().toLowerCase();

  // Order is only meaningful WITHIN a folder/label — that's how mail is actually viewed, and
  // each folder has its own sequence. Comparing positions ACROSS folders (or across subject
  // families that each restart at "Email 1") produces false mismatches. So we verify each
  // mail's position only against the other mails in its own source folder.
  const groups = new Map();
  for (const r of paired) {
    const k = folderKeyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const outOfOrder = [];
  let checked = 0;
  let foldersChecked = 0;

  for (const msgs of groups.values()) {
    if (msgs.length < 2) continue; // a lone mail in a folder has no relative order to verify
    foldersChecked++;
    checked += msgs.length;

    // Expected order: source time, then subject sequence (disambiguates same-timestamp mails), then id.
    const expected = [...msgs].sort((a, b) =>
      (Number(a._srcTimestampMs) - Number(b._srcTimestampMs)) ||
      (seqOf(a) - seqOf(b)) ||
      String(a.sourceMessageId).localeCompare(String(b.sourceMessageId))
    );
    // Actual order: destination time, with the SAME tiebreakers — so mails that are genuinely
    // indistinguishable at the destination (identical dst time) are treated as in-order, not flagged.
    const actual = [...msgs].sort((a, b) =>
      (Number(a._dstTimestampMs) - Number(b._dstTimestampMs)) ||
      (seqOf(a) - seqOf(b)) ||
      String(a.sourceMessageId).localeCompare(String(b.sourceMessageId))
    );

    const expRank = new Map(expected.map((r, i) => [r.sourceMessageId, i]));
    const actRank = new Map(actual.map((r, i) => [r.sourceMessageId, i]));

    for (const r of msgs) {
      const sp = expRank.get(r.sourceMessageId);
      const dp = actRank.get(r.sourceMessageId);
      if (sp === dp) continue;
      // Whether this mail shared a source timestamp with a folder-mate (→ seq# disambiguated it).
      const sharedTs = msgs.some(
        (o) => o !== r && Number(o._srcTimestampMs) === Number(r._srcTimestampMs)
      );
      const seqNum = extractSubjectSequence(r.subject);
      outOfOrder.push({
        sourceMessageId: r.sourceMessageId,
        subject: r.subject || '',
        folder: r._srcFolder || '',
        folderKind: r._srcFolderKind || 'folder',
        destFolder: r._dstFolder || '',
        destFolderKind: r._dstFolderKind || 'folder',
        ...(seqNum != null ? { sequenceNumber: seqNum } : {}),
        srcPosition: sp + 1,
        dstPosition: dp + 1,
        srcTimestampMs: Number(r._srcTimestampMs),
        dstTimestampMs: Number(r._dstTimestampMs),
        validatedBy: sharedTs ? 'subject-sequence' : 'timestamp',
      });
    }
  }

  const pass = outOfOrder.length === 0;
  result.deepMailValidation.orderValidation = {
    totalChecked: checked,
    foldersChecked,
    outOfOrderCount: outOfOrder.length,
    // 'label' (Gmail) or 'folder' (Outlook) — for the report column headers.
    folderKind: paired[0]?._srcFolderKind || 'folder',
    destFolderKind: paired[0]?._dstFolderKind || 'folder',
    pass,
    outOfOrder,
  };

  if (pass) {
    log.info(`Order validation: ${checked} mail(s) across ${foldersChecked} folder(s) — order preserved within every folder`);
  } else {
    log.warn(`Order validation: ${outOfOrder.length}/${checked} mail(s) arrived in a different position within their folder`);
  }
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
  extractAnchorHrefs,
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
  validateGmailToOutlookThreadChains,
  tierBHashesGmailToGmail,
  validateMailOrderByTimestamp,
};
