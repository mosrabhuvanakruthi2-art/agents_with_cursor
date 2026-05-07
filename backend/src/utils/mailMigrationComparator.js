/**
 * Normalize and compare mail fields for deep migration validation (Tier A/B/C).
 */

const crypto = require('crypto');

/**
 * @typedef {object} FieldDiff
 * @property {string} field
 * @property {boolean} ok
 * @property {string} [expected] - For From/To/Cc/Bcc: value *expected on the destination* after permission mapping (not the Gmail raw value).
 * @property {string} [actual] - Value read from the destination message.
 * @property {string} [displaySource] - Gmail / source-side value for reports (raw From, To, subject, body, etc.).
 * @property {string} [displayDestination] - Outlook / destination-side value for reports.
 * @property {'error'|'warning'} [severity]
 */

/**
 * Decode MIME encoded-words in subject lightly; trim/collapse whitespace.
 */
function normalizeSubject(subject) {
  let s = String(subject || '').trim();
  const m = s.match(/^=\?([^?]+)\?([bqBQ])\?([^?]*)\?=$/);
  if (m && m[2].toUpperCase() === 'B') {
    try {
      s = Buffer.from(m[3], 'base64').toString('utf8');
    } catch {
      /* keep s */
    }
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extract bare email addresses from a From/To/Cc/Bcc header line (comma-separated).
 */
function parseRecipientEmails(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return [];
  const emails = [];
  const re = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  let match;
  while ((match = re.exec(headerValue)) !== null) {
    emails.push(match[1].toLowerCase());
  }
  return [...new Set(emails)].sort();
}

/**
 * Graph recipient array → sorted unique lowercase emails.
 */
function graphRecipientsToEmails(recipientArray) {
  if (!recipientArray || !Array.isArray(recipientArray)) return [];
  const emails = [];
  for (const r of recipientArray) {
    const addr = r.emailAddress?.address || r.emailAddress?.name;
    if (addr && addr.includes('@')) emails.push(String(addr).toLowerCase());
  }
  return [...new Set(emails)].sort();
}

/**
 * Graph API single `from` object → sorted unique lowercase emails (normally one).
 */
function graphFromToEmails(fromObj) {
  if (!fromObj || typeof fromObj !== 'object') return [];
  const addr = fromObj.emailAddress?.address || fromObj.emailAddress?.name;
  if (addr && String(addr).includes('@')) return [String(addr).toLowerCase()].sort();
  return [];
}

function sourceTierAFromEmails(source) {
  if (Array.isArray(source.fromEmails)) {
    return [...new Set(source.fromEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort();
  }
  if (source.from && typeof source.from === 'object' && source.from.emailAddress) {
    return graphFromToEmails(source.from);
  }
  return parseRecipientEmails(source.from || '');
}

function destTierAFromEmails(dest) {
  if (Array.isArray(dest.fromEmails)) {
    return [...new Set(dest.fromEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))].sort();
  }
  return graphFromToEmails(dest.from || null);
}

/**
 * Attachment lists for Tier A: [{ name, size }] sorted by name (Gmail / Graph normalized).
 */
function normalizeAttachmentListForCompare(items) {
  if (!items || !Array.isArray(items)) return [];
  return items
    .map((a) => ({
      name: String(a.filename || a.name || '').trim(),
      size: Number(a.size || a.sizeBytes || 0),
    }))
    .filter((a) => a.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Gmail reports attachment.size as the decoded body bytes; Microsoft Graph reports a different
 * size metric (roughly base64-encoded bytes + MIME envelope) so a byte-for-byte size compare is
 * not meaningful across the two APIs. Match by sorted filename only; Tier B attachment-hash
 * compare (compareTierBHashes) is the correct way to prove attachment byte integrity.
 */
function attachmentListsEqual(a, b) {
  const aa = normalizeAttachmentListForCompare(a);
  const bb = normalizeAttachmentListForCompare(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i].name !== bb[i].name) return false;
  }
  return true;
}

/**
 * Build Map<sourceLower, destLower> from UI user mappings + optional primary mailbox pair.
 * @param {{ sourceEmail?: string, destinationEmail?: string }[]} rows
 * @param {{ sourceEmail?: string, destinationEmail?: string }} [primaryPair]
 */
function buildRecipientEmailMapping(rows, primaryPair) {
  const m = new Map();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const s = String(row?.sourceEmail ?? '').trim().toLowerCase();
      const d = String(row?.destinationEmail ?? '').trim().toLowerCase();
      if (s && d) m.set(s, d);
    }
  }
  if (primaryPair) {
    const se = String(primaryPair.sourceEmail ?? '').trim().toLowerCase();
    const de = String(primaryPair.destinationEmail ?? '').trim().toLowerCase();
    if (se && de && !m.has(se)) m.set(se, de);
  }
  return m;
}

/**
 * Apply tenant user mapping: each source address becomes its mapped destination, or unchanged.
 * Input / output: sorted unique lowercase emails.
 */
function expectedDestRecipientsFromSource(sourceSortedLower, mappingMap) {
  if (!mappingMap || mappingMap.size === 0) return sourceSortedLower;
  const mapped = sourceSortedLower.map((e) => mappingMap.get(e) ?? e);
  return [...new Set(mapped)].sort();
}

/**
 * Strip HTML tags for loose body comparison (Tier C warning).
 */
function htmlToPlainLoose(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tier A: subject, from (when recipient mapping provided), to/cc/bcc sets, attachment names + sizes (no byte download).
 * @param {object} source - { subject, from?, fromEmails?, toEmails?, ccEmails?, bccEmails?, attachments?: {filename,size}[] }
 * @param {object} dest - { subject, from?, fromEmails?, toRecipients?, ccRecipients?, bccRecipients?, attachments?: {name,size}[] }
 * @param {{ compareBcc?: boolean }} opts
 * @returns {FieldDiff[]}
 */
function compareTierA(source, dest, opts = {}) {
  const compareBcc = opts.compareBcc !== false;
  /** @type {Map<string,string>|null} */
  const mappingMap =
    opts.recipientMapping instanceof Map && opts.recipientMapping.size > 0 ? opts.recipientMapping : null;
  const diffs = [];

  // From: migration preserves the original sender address (e.g. Peter stays Peter in migrated Sent Items).
  // Compare raw source vs destination; do NOT apply user-mapping — that's for recipients in the dest tenant.
  {
    const sFromRaw = sourceTierAFromEmails(source);
    const dFrom = destTierAFromEmails(dest);
    if (sFromRaw.length > 0 && JSON.stringify(sFromRaw) !== JSON.stringify(dFrom)) {
      diffs.push({
        field: 'from',
        ok: false,
        expected: sFromRaw.join(','),
        actual: dFrom.join(','),
        displaySource: sFromRaw.join(','),
        displayDestination: dFrom.join(','),
        severity: 'error',
      });
    }
  }

  const sSub = normalizeSubject(source.subject);
  const dSub = normalizeSubject(dest.subject);
  if (sSub !== dSub) {
    diffs.push({
      field: 'subject',
      ok: false,
      expected: sSub,
      actual: dSub,
      displaySource: sSub,
      displayDestination: dSub,
      severity: 'error',
    });
  }

  const sToRaw = source.toEmails || parseRecipientEmails(source.to || '');
  const dTo = dest.toEmails || graphRecipientsToEmails(dest.toRecipients);
  const expectedTo = mappingMap ? expectedDestRecipientsFromSource(sToRaw, mappingMap) : sToRaw;
  if (JSON.stringify(expectedTo) !== JSON.stringify(dTo)) {
    diffs.push({
      field: 'to',
      ok: false,
      expected: expectedTo.join(','),
      actual: dTo.join(','),
      displaySource: sToRaw.join(','),
      displayDestination: dTo.join(','),
      severity: 'error',
    });
  }

  const sCcRaw = source.ccEmails || parseRecipientEmails(source.cc || '');
  const dCc = dest.ccEmails || graphRecipientsToEmails(dest.ccRecipients);
  const expectedCc = mappingMap ? expectedDestRecipientsFromSource(sCcRaw, mappingMap) : sCcRaw;
  if (JSON.stringify(expectedCc) !== JSON.stringify(dCc)) {
    diffs.push({
      field: 'cc',
      ok: false,
      expected: expectedCc.join(','),
      actual: dCc.join(','),
      displaySource: sCcRaw.join(','),
      displayDestination: dCc.join(','),
      severity: 'error',
    });
  }

  if (compareBcc) {
    const sBccRaw = source.bccEmails || parseRecipientEmails(source.bcc || '');
    const dBcc = dest.bccEmails || graphRecipientsToEmails(dest.bccRecipients);
    const expectedBcc = mappingMap ? expectedDestRecipientsFromSource(sBccRaw, mappingMap) : sBccRaw;
    const bccSev = opts.bccAsError !== false ? 'error' : 'warning';
    if (JSON.stringify(expectedBcc) !== JSON.stringify(dBcc)) {
      diffs.push({
        field: 'bcc',
        ok: false,
        expected: expectedBcc.join(','),
        actual: dBcc.join(','),
        displaySource: sBccRaw.join(','),
        displayDestination: dBcc.join(','),
        severity: bccSev,
      });
    }
  }

  const srcAtt = source.attachments || [];
  const dstAtt = dest.attachments || [];
  if (!attachmentListsEqual(srcAtt, dstAtt)) {
    const expJ = JSON.stringify(normalizeAttachmentListForCompare(srcAtt));
    const actJ = JSON.stringify(normalizeAttachmentListForCompare(dstAtt));
    diffs.push({
      field: 'attachments',
      ok: false,
      expected: expJ,
      actual: actJ,
      displaySource: expJ,
      displayDestination: actJ,
      severity: 'error',
    });
  }

  return diffs;
}

function normalizeMailBodyPlain(s) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Gmail system labels ↔ Outlook system folders (lowercased, space-stripped forms). */
const SYSTEM_FOLDER_EQUIV = new Map([
  ['sent', 'sentitems'],
  ['inbox', 'inbox'],
  ['drafts', 'drafts'],
  ['draft', 'drafts'],
  ['trash', 'deleteditems'],
  ['deleted', 'deleteditems'],
  ['spam', 'junkemail'],
  ['junk', 'junkemail'],
  ['archive', 'archive'],
  ['important', 'important'],
  ['starred', 'starred'],
]);

function canonicalizeSystemFolderSegments(path) {
  return path
    .split('/')
    .map((seg) => SYSTEM_FOLDER_EQUIV.get(seg) || seg)
    .filter(Boolean)
    .join('/');
}

/** Loose folder/label path compare (Gmail label names vs Outlook folder path). */
function normalizeFolderPathForCompare(s) {
  const base = String(s || '')
    .toLowerCase()
    .replace(/\s*\|\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/[^a-z0-9/._-]+/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const canon = canonicalizeSystemFolderSegments(base);
  return canon.replace(/^inbox\/?/, '');
}

/**
 * Compare Gmail label placement string vs Outlook folder path (best-effort).
 */
function compareFolderPlacement(sourceLabelsJoined, destFolderPath, options = {}) {
  const a = normalizeFolderPathForCompare(sourceLabelsJoined);
  const b = normalizeFolderPathForCompare(destFolderPath);
  if (!sourceLabelsJoined && !destFolderPath) return [];
  if (a === b) return [];
  const srcL = String(sourceLabelsJoined || '');
  const dstP = String(destFolderPath || '');
  return [
    {
      field: 'folder',
      ok: false,
      expected: srcL,
      actual: dstP,
      displaySource: srcL,
      displayDestination: dstP,
      severity: options.folderMismatchSeverity === 'warning' ? 'warning' : 'error',
    },
  ];
}

// ── Gmail → Outlook placement rules ─────────────────────────────────────────

/**
 * Gmail system label IDs that are never migrated as-is.
 *   SNOOZED / SCHEDULED: not migrated at all. If the only label on a Gmail message is one of
 *   these, we do not expect a destination message (caller decides how to surface that).
 *   CHAT / CHATS:        Hangouts/Chat records are not mail.
 */
const GMAIL_LABELS_NEVER_MIGRATED = new Set(['SNOOZED', 'SCHEDULED', 'CHAT', 'CHATS']);

/**
 * Gmail system label → Outlook well-known folder name. Category labels become same-named folders.
 */
const GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER = new Map([
  ['INBOX', 'Inbox'],
  ['SENT', 'Sent Items'],
  ['DRAFT', 'Drafts'],
  ['DRAFTS', 'Drafts'],
  ['TRASH', 'Deleted Items'],
  ['SPAM', 'Junk Email'],
  ['CATEGORY_FORUMS', 'CATEGORY_FORUMS'],
  ['CATEGORY_PROMOTIONS', 'CATEGORY_PROMOTIONS'],
  ['CATEGORY_SOCIAL', 'CATEGORY_SOCIAL'],
  ['CATEGORY_UPDATES', 'CATEGORY_UPDATES'],
  ['CATEGORY_PERSONAL', 'CATEGORY_PERSONAL'],
]);

/** Gmail labels that carry a marker (flag/importance) on the Outlook message rather than a folder move. */
const GMAIL_SYSTEM_MARKER_LABELS = new Set(['STARRED', 'IMPORTANT', 'UNREAD']);

/**
 * Separator symbols the caller can use when passing Gmail labels as a single string.
 * Same as the output of gmailClient.formatGmailLabelsForCompare (" | " join).
 */
const LABEL_SEPARATOR_RE = /\s*[|,;]\s*/;

function parseGmailLabels(labels) {
  if (Array.isArray(labels)) return labels.map((x) => String(x || '').trim()).filter(Boolean);
  return String(labels || '')
    .split(LABEL_SEPARATOR_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Given a set of Gmail labels on a message, compute the Outlook folder name the migration should
 * place the message in, per CloudFuze Gmail→Outlook mapping (documented by ProServ):
 *
 *   • If the message has STARRED:
 *       - with INBOX    → Inbox              (original location wins, Outlook is flagged)
 *       - with SENT     → Sent Items
 *       - with a custom label → that label's folder
 *       - with only STARRED (no other labels) → YELLOW_STAR
 *   • If no STARRED: pick the first matching system folder in priority order
 *     INBOX → SENT → DRAFT → TRASH → SPAM → CATEGORY_* → first custom label.
 *   • Archived / All-Mail-only with no labels:
 *     if `migrateOrphaned` is true → "Archive" else the caller should treat as "not migrated".
 *
 * @param {string[] | string} labels Gmail label names (IDs expanded by caller already).
 * @param {{ migrateOrphaned?: boolean }} [opts]
 * @returns {{ expectedFolder: string | null, reason: string, source: 'system'|'custom'|'starred-only'|'orphan'|'never-migrated' }}
 */
function expectedOutlookFolderForGmailLabels(labels, opts = {}) {
  const list = parseGmailLabels(labels);
  if (list.length === 0) {
    return {
      expectedFolder: opts.migrateOrphaned ? 'Archive' : null,
      reason: opts.migrateOrphaned
        ? 'No labels → Archive (Migrate Orphaned Labels enabled)'
        : 'No labels → All Mail only; not migrated unless Migrate Orphaned Labels is enabled',
      source: 'orphan',
    };
  }

  const upper = list.map((l) => String(l || '').toUpperCase());

  const systemOnlyBlocking = list.every((l) => GMAIL_LABELS_NEVER_MIGRATED.has(String(l || '').toUpperCase()));
  if (systemOnlyBlocking) {
    return {
      expectedFolder: null,
      reason: `Gmail-only label(s) [${list.join(', ')}] are never migrated`,
      source: 'never-migrated',
    };
  }

  const hasStarred = upper.includes('STARRED');
  const isMarker = (l) => GMAIL_SYSTEM_MARKER_LABELS.has(String(l || '').toUpperCase());
  const isNeverMigrated = (l) => GMAIL_LABELS_NEVER_MIGRATED.has(String(l || '').toUpperCase());

  const PRIORITY = ['INBOX', 'SENT', 'DRAFT', 'DRAFTS', 'TRASH', 'SPAM'];
  const priorityMatch = PRIORITY.find((sys) => upper.includes(sys));
  const categoryMatch = list.find((l) => GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.has(String(l).toUpperCase())
    && String(l).toUpperCase().startsWith('CATEGORY_'));
  const firstCustom = list.find((l) => {
    const U = String(l || '').toUpperCase();
    return !GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.has(U) && !isMarker(l) && !isNeverMigrated(l);
  });

  if (priorityMatch) {
    return {
      expectedFolder: GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(priorityMatch),
      reason: `Gmail system label ${priorityMatch} ≡ Outlook "${GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(priorityMatch)}"${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
      source: 'system',
    };
  }

  if (firstCustom) {
    return {
      expectedFolder: firstCustom,
      reason: `Custom Gmail label "${firstCustom}" → same-name Outlook folder${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
      source: 'custom',
    };
  }

  if (categoryMatch) {
    return {
      expectedFolder: GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(categoryMatch.toUpperCase()),
      reason: `Gmail category ${categoryMatch} → Outlook folder "${GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(categoryMatch.toUpperCase())}"${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
      source: 'system',
    };
  }

  if (hasStarred) {
    return {
      expectedFolder: 'YELLOW_STAR',
      reason: 'STARRED only (no other labels) → YELLOW_STAR folder with red flag',
      source: 'starred-only',
    };
  }

  return {
    expectedFolder: opts.migrateOrphaned ? 'Archive' : null,
    reason: opts.migrateOrphaned
      ? 'No primary folder label → Archive (Migrate Orphaned Labels enabled)'
      : 'No primary folder label and Migrate Orphaned Labels is not enabled — not migrated',
    source: 'orphan',
  };
}

function folderPathLeaf(folderPath) {
  const s = String(folderPath || '').trim();
  if (!s) return '';
  const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function normalizedFolderLeaf(folderPath) {
  const leaf = folderPathLeaf(folderPath).toLowerCase().replace(/\s+/g, '');
  return canonicalizeSystemFolderSegments(leaf);
}

function normalizedNameEquals(a, b) {
  return normalizedFolderLeaf(a) === normalizedFolderLeaf(b);
}

/**
 * Validate Gmail→Outlook message placement + markers per CloudFuze migration rules.
 *
 *   Folder: expected folder computed from labels (see expectedOutlookFolderForGmailLabels).
 *   STARRED: Outlook message must have flag.flagStatus === "flagged" (red flag in UI).
 *   IMPORTANT: Outlook message must have importance === "high" (exclamation mark).
 *
 * @param {object} input
 * @param {string[] | string} input.gmailLabels label names on the Gmail source message
 * @param {string} input.destFolderPath Outlook folder path (e.g. "Inbox/QA-TestLabel")
 * @param {{ flagStatus?: string } | null} [input.destFlag] message flag from Graph
 * @param {'low'|'normal'|'high'} [input.destImportance] message importance from Graph
 * @param {{ migrateOrphaned?: boolean, severity?: 'error'|'warning' }} [input.options]
 * @returns {FieldDiff[]} one entry per mismatch (folder, flag, importance).
 */
function validateGmailToOutlookPlacement(input) {
  const {
    gmailLabels,
    destFolderPath,
    destFlag = null,
    destImportance = null,
    options = {},
  } = input || {};
  const severity = options.severity === 'warning' ? 'warning' : 'error';
  const diffs = [];

  const upper = parseGmailLabels(gmailLabels).map((l) => l.toUpperCase());
  const hasStarred = upper.includes('STARRED');
  const hasImportant = upper.includes('IMPORTANT');

  const rule = expectedOutlookFolderForGmailLabels(gmailLabels, {
    migrateOrphaned: options.migrateOrphaned === true,
  });

  if (rule.expectedFolder === null && rule.source === 'never-migrated') {
    if (destFolderPath) {
      diffs.push({
        field: 'folder',
        ok: false,
        expected: '(not migrated)',
        actual: destFolderPath,
        displaySource: parseGmailLabels(gmailLabels).join(' | '),
        displayDestination: `${destFolderPath} — but ${rule.reason}`,
        severity,
      });
    }
  } else if (rule.expectedFolder === null && rule.source === 'orphan') {
    if (destFolderPath) {
      diffs.push({
        field: 'folder',
        ok: false,
        expected: '(not migrated — orphaned label handling disabled)',
        actual: destFolderPath,
        displaySource: parseGmailLabels(gmailLabels).join(' | ') || '(no labels)',
        displayDestination: `${destFolderPath} — ${rule.reason}`,
        severity: 'warning',
      });
    }
  } else if (rule.expectedFolder) {
    const expected = rule.expectedFolder;
    if (!destFolderPath) {
      diffs.push({
        field: 'folder',
        ok: false,
        expected,
        actual: '(missing)',
        displaySource: parseGmailLabels(gmailLabels).join(' | ') || '(no labels)',
        displayDestination: `(no folder) — expected "${expected}" per mapping: ${rule.reason}`,
        severity,
      });
    } else if (!normalizedNameEquals(expected, destFolderPath)) {
      diffs.push({
        field: 'folder',
        ok: false,
        expected,
        actual: destFolderPath,
        displaySource: parseGmailLabels(gmailLabels).join(' | ') || '(no labels)',
        displayDestination: `${destFolderPath} — expected "${expected}" per mapping: ${rule.reason}`,
        severity,
      });
    }
  }

  if (hasStarred) {
    const status = String(destFlag?.flagStatus || '').toLowerCase();
    if (status !== 'flagged') {
      diffs.push({
        field: 'starred',
        ok: false,
        expected: 'Outlook flag.flagStatus = flagged (red flag)',
        actual: status || '(not flagged)',
        displaySource: 'Gmail STARRED',
        displayDestination:
          status === 'complete'
            ? 'flag.flagStatus = complete — STARRED should map to red flag (flagged), not complete'
            : '(no red flag) — Gmail STARRED should become Outlook red flag (flag.flagStatus = flagged)',
        severity,
      });
    }
  }

  if (hasImportant) {
    const importance = String(destImportance || '').toLowerCase();
    if (importance !== 'high') {
      diffs.push({
        field: 'important',
        ok: false,
        expected: 'Outlook importance = high (exclamation mark)',
        actual: importance || '(not set)',
        displaySource: 'Gmail IMPORTANT',
        displayDestination: `importance = ${importance || '(not set)'} — IMPORTANT should become importance = high`,
        severity,
      });
    }
  }

  return diffs;
}

/**
 * Tier C: full normalized plain body vs destination HTML/plain (strict when bodyMismatchSeverity=error).
 */
function compareTierC(sourcePlain, destHtmlOrPlain, options = {}) {
  const diffs = [];
  const maxChars =
    typeof options.maxChars === 'number'
      ? options.maxChars
      : parseInt(process.env.MAIL_DEEP_BODY_MAX_CHARS || '', 10) || 500000;
  const hasAttachments = options.hasAttachments === true;
  const destHasAttachments = options.destHasAttachments === true;
  let s = normalizeMailBodyPlain(sourcePlain || '');
  let d = normalizeMailBodyPlain(htmlToPlainLoose(destHtmlOrPlain?.content || destHtmlOrPlain || ''));
  if (!s && !d) return diffs;
  if (s.length > maxChars) s = s.substring(0, maxChars);
  if (d.length > maxChars) d = d.substring(0, maxChars);
  if (s === d) return diffs;
  const previewLen = Math.min(8000, Math.max(500, Math.min(s.length || 1, d.length || 1, 4000)));
  const expPrev = s.length > previewLen ? `${s.substring(0, previewLen)}… [${s.length} chars]` : s;
  const actPrev = d.length > previewLen ? `${d.substring(0, previewLen)}… [${d.length} chars]` : d;
  /**
   * When the source carries body text but the destination body normalizes to empty string, the
   * reader sees a confusing blank red cell. Surface the reason + suggested action so the QA
   * tester can act on it (most common cause on Gmail→Outlook: CloudFuze import dropping the
   * HTML text body when the message has attachments; attachments themselves migrate fine).
   *
   * If the destination message has the attachments, do not falsely imply the attachments are
   * missing — call out that only the text body is missing.
   */
  const srcHasText = s.length > 0;
  const destIsEmpty = d.length === 0;
  let displayDestination = actPrev;
  let note;
  if (srcHasText && destIsEmpty) {
    if (hasAttachments && destHasAttachments) {
      note = 'Text body missing (attachments migrated OK). Re-migrate this message or raise a support ticket.';
      displayDestination = note;
    } else if (hasAttachments && !destHasAttachments) {
      note = 'Body and attachments missing on destination. Re-migrate this message or raise a support ticket.';
      displayDestination = note;
    } else {
      note = 'Body not migrated. Re-migrate this message or raise a support ticket.';
      displayDestination = note;
    }
  }
  diffs.push({
    field: 'body',
    ok: false,
    expected: expPrev,
    actual: actPrev,
    displaySource: expPrev,
    displayDestination,
    note,
    severity: options.bodyMismatchSeverity || 'warning',
    fullExpectedLen: s.length,
    fullActualLen: d.length,
  });
  return diffs;
}

/**
 * Tier B: SHA-256 pairs for attachment bodies (caller supplies hex hashes per file).
 * @param {{ name: string, sha256?: string }[]} sourceHashes
 * @param {{ name: string, sha256?: string }[]} destHashes
 */
function compareTierBHashes(sourceHashes, destHashes) {
  const diffs = [];
  const sm = new Map((sourceHashes || []).map((h) => [h.name, h.sha256]));
  const dm = new Map((destHashes || []).map((h) => [h.name, h.sha256]));
  const names = new Set([...sm.keys(), ...dm.keys()]);
  for (const name of names) {
    const a = sm.get(name);
    const b = dm.get(name);
    if (a && b && a !== b) {
      diffs.push({
        field: `attachmentHash:${name}`,
        ok: false,
        expected: a,
        actual: b,
        displaySource: a,
        displayDestination: b,
        severity: 'error',
      });
    }
  }
  return diffs;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  normalizeSubject,
  parseRecipientEmails,
  graphRecipientsToEmails,
  graphFromToEmails,
  normalizeAttachmentListForCompare,
  buildRecipientEmailMapping,
  expectedDestRecipientsFromSource,
  compareTierA,
  compareTierC,
  compareTierBHashes,
  compareFolderPlacement,
  expectedOutlookFolderForGmailLabels,
  validateGmailToOutlookPlacement,
  GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER,
  GMAIL_LABELS_NEVER_MIGRATED,
  parseGmailLabels,
  normalizeMailBodyPlain,
  htmlToPlainLoose,
  sha256Hex,
};
