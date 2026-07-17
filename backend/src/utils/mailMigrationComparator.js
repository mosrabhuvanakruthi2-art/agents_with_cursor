/**
 * Normalize and compare mail fields for deep migration validation (Tier A/B/C).
 */

const crypto = require('crypto');
const tolerance = require('./mailTolerance');

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

  // Reply-To: warn when source sets a replyTo that differs from the destination
  {
    const sReplyTo = source.replyToEmails && Array.isArray(source.replyToEmails)
      ? [...new Set(source.replyToEmails.map((e) => String(e).toLowerCase()).filter(Boolean))].sort()
      : graphRecipientsToEmails(source.replyTo);
    const dReplyTo = dest.replyToEmails && Array.isArray(dest.replyToEmails)
      ? [...new Set(dest.replyToEmails.map((e) => String(e).toLowerCase()).filter(Boolean))].sort()
      : dest.replyTo && typeof dest.replyTo === 'string'
        ? parseRecipientEmails(dest.replyTo)
        : graphRecipientsToEmails(dest.replyTo);
    if (sReplyTo.length > 0 && JSON.stringify(sReplyTo) !== JSON.stringify(dReplyTo)) {
      diffs.push({
        field: 'replyTo',
        ok: false,
        expected: sReplyTo.join(','),
        actual: dReplyTo.join(','),
        displaySource: sReplyTo.join(','),
        displayDestination: dReplyTo.join(','),
        severity: 'warning',
      });
    }
  }

  const srcAtt = source.attachments || [];
  const dstAtt = dest.attachments || [];
  if (!attachmentListsEqual(srcAtt, dstAtt)) {
    const expJ = JSON.stringify(normalizeAttachmentListForCompare(srcAtt));
    const actJ = JSON.stringify(normalizeAttachmentListForCompare(dstAtt));

    // Outlook→Gmail: Gmail imposes a 25 MB attachment limit on individual messages.
    // CloudFuze converts binary attachments >25 MB to Google Drive links stored in the
    // message body instead of as fileAttachments.  The Graph/Gmail APIs see no attachment
    // in the destination, but the file is still accessible via the Drive link.
    // Downgrade from error to info so this expected conversion doesn't block QA.
    const GMAIL_ATTACH_LIMIT = 25 * 1024 * 1024; // 25 MB
    const combination = opts.combination || '';
    const allSrcLarge = srcAtt.length > 0 && dstAtt.length === 0 &&
      combination === 'outlook_to_gmail' &&
      normalizeAttachmentListForCompare(srcAtt).every((a) => a.size > GMAIL_ATTACH_LIMIT);

    diffs.push({
      field: 'attachments',
      ok: allSrcLarge,
      expected: expJ,
      actual: actJ,
      displaySource: expJ,
      displayDestination: actJ,
      severity: allSrcLarge ? 'info' : 'error',
      ...(allSrcLarge ? {
        note: 'All source attachments exceed Gmail\'s 25 MB limit — CloudFuze converts them to Google Drive links in the message body. No binary attachment is expected in destination.',
      } : {}),
    });
  }

  return diffs;
}

/**
 * Decode the common HTML entities so a body stored as HTML (Outlook destination) compares equal to
 * the plain-text source. Outlook stores quotes as &quot;, ampersands as &amp;, etc. — without this,
 * `"QA-TestLabel"` (source) vs `&quot;QA-TestLabel&quot;` (destination) was flagged as a body
 * mismatch even though they render identically. Decode &amp; LAST so "&amp;quot;" isn't over-decoded.
 */
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&quot;/gi, '"').replace(/&#0*34;/g, '"')
    .replace(/&apos;/gi, "'").replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&#0*160;/g, ' ')
    .replace(/&lt;/gi, '<').replace(/&#0*60;/g, '<')
    .replace(/&gt;/gi, '>').replace(/&#0*62;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return _; } })
    .replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&');
}

function normalizeMailBodyPlain(s) {
  return decodeHtmlEntities(String(s || ''))
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
 * @param {{ migrateOrphaned?: boolean, archiveMailbox?: boolean }} [opts]
 * @returns {{ expectedFolder: string | null, reason: string, source: 'system'|'custom'|'starred-only'|'orphan'|'never-migrated'|'all-mail' }}
 */
// Outlook destination folder CloudFuze creates for archived (All-Mail-only) Gmail mail when the
// "Archive Mailbox" migration option is enabled.
const GMAIL_ALL_MAIL_FOLDER = '[Gmail]All Mail';
function expectedOutlookFolderForGmailLabels(labels, opts = {}) {
  const list = parseGmailLabels(labels);
  if (list.length === 0) {
    // Archived, label-less mail (only in Gmail "All Mail"). When the CloudFuze "Archive Mailbox"
    // option is ON, these migrate to an Outlook custom folder named "[Gmail]All Mail". Otherwise they
    // fall back to the Migrate-Orphaned-Labels behaviour (Archive, or not migrated).
    if (opts.archiveMailbox) {
      return {
        expectedFolder: GMAIL_ALL_MAIL_FOLDER,
        reason: `No labels (archived) → Outlook "${GMAIL_ALL_MAIL_FOLDER}" (Archive Mailbox enabled)`,
        source: 'all-mail',
      };
    }
    return {
      expectedFolder: opts.migrateOrphaned ? 'Archive' : null,
      reason: opts.migrateOrphaned
        ? 'No labels → Archive (Migrate Orphaned Labels enabled)'
        : 'No labels → All Mail only; not migrated unless Archive Mailbox / Migrate Orphaned Labels is enabled',
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

  // A Gmail mail with MULTIPLE folder-mapping labels legitimately lands in EACH mapped Outlook folder
  // (e.g. SENT + ProjectX → the mail exists in BOTH "Sent Items" AND "ProjectX"). Collect every
  // acceptable folder so the placement check passes when the message is found in ANY of them — not
  // only the single priority pick. (STARRED/IMPORTANT/UNREAD are flags, not folders → excluded.)
  const acceptableFolders = [...new Set(
    list
      .filter((l) => !isMarker(l) && !isNeverMigrated(l))
      .map((l) => {
        const U = String(l || '').toUpperCase();
        return GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.has(U) ? GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(U) : l;
      })
      .filter(Boolean)
  )];

  if (priorityMatch) {
    return {
      expectedFolder: GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(priorityMatch),
      acceptableFolders,
      reason: `Gmail system label ${priorityMatch} ≡ Outlook "${GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(priorityMatch)}"${acceptableFolders.length > 1 ? ` (also acceptable: ${acceptableFolders.join(', ')})` : ''}${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
      source: 'system',
    };
  }

  if (firstCustom) {
    return {
      expectedFolder: firstCustom,
      acceptableFolders,
      reason: `Custom Gmail label "${firstCustom}" → same-name Outlook folder${acceptableFolders.length > 1 ? ` (also acceptable: ${acceptableFolders.join(', ')})` : ''}${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
      source: 'custom',
    };
  }

  if (categoryMatch) {
    return {
      expectedFolder: GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(categoryMatch.toUpperCase()),
      acceptableFolders,
      reason: `Gmail category ${categoryMatch} → Outlook folder "${GMAIL_SYSTEM_LABEL_TO_OUTLOOK_FOLDER.get(categoryMatch.toUpperCase())}"${acceptableFolders.length > 1 ? ` (also acceptable: ${acceptableFolders.join(', ')})` : ''}${hasStarred ? ' (STARRED kept as red flag in original folder)' : ''}`,
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

  // No primary folder label (archived, only in All Mail). Same rule as the no-labels case above:
  // "[Gmail]All Mail" when Archive Mailbox is on, else the orphaned-label fallback.
  if (opts.archiveMailbox) {
    return {
      expectedFolder: GMAIL_ALL_MAIL_FOLDER,
      reason: `No primary folder label (archived) → Outlook "${GMAIL_ALL_MAIL_FOLDER}" (Archive Mailbox enabled)`,
      source: 'all-mail',
    };
  }
  return {
    expectedFolder: opts.migrateOrphaned ? 'Archive' : null,
    reason: opts.migrateOrphaned
      ? 'No primary folder label → Archive (Migrate Orphaned Labels enabled)'
      : 'No primary folder label and Archive Mailbox / Migrate Orphaned Labels is not enabled — not migrated',
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
    archiveMailbox: options.archiveMailbox === true,
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
    // A mail with several folder-mapping labels lands in EACH mapped folder — accept ANY of them.
    const accept = (rule.acceptableFolders && rule.acceptableFolders.length)
      ? rule.acceptableFolders
      : [expected];
    const matchesAny = destFolderPath && accept.some((f) => normalizedNameEquals(f, destFolderPath));
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
    } else if (!matchesAny) {
      diffs.push({
        field: 'folder',
        ok: false,
        expected: accept.join(' or '),
        actual: destFolderPath,
        displaySource: parseGmailLabels(gmailLabels).join(' | ') || '(no labels)',
        displayDestination: `${destFolderPath} — expected one of [${accept.join(', ')}] per mapping: ${rule.reason}`,
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

/**
 * Compare attachment sizes across platforms, accounting for base64 encoding overhead.
 *
 * Why sizes differ:
 *   Gmail API  → reports the decoded binary size (raw file bytes).
 *   Graph API  → reports the base64-encoded + MIME-envelope size (~33–45 % larger).
 *
 * So for Gmail→Outlook: dest size ≈ src × 1.33–1.45  (encoding added at destination)
 *    for Outlook→Gmail: dest size ≈ src × 0.68–0.75  (encoding removed at destination)
 *    for same-platform: dest size ≈ src × ~1.0        (no encoding change)
 *
 * Severity rules (based on dest/src ratio):
 *   'info'    – ratio within expected encoding range; content may still be intact.
 *   'warning' – ratio slightly outside expected; recommend Tier B hash verification.
 *   'error'   – ratio far outside expected; possible truncation or corruption.
 *
 * @param {Array<{filename?:string, name?:string, size:number}>} srcAttachments
 * @param {Array<{filename?:string, name?:string, size:number}>} dstAttachments
 * @param {'gmail_to_outlook'|'outlook_to_gmail'|'outlook_to_outlook'|'gmail_to_gmail'} combination
 * @returns {FieldDiff[]}
 */
function compareAttachmentSizesWithTolerance(srcAttachments, dstAttachments, combination) {
  if (!srcAttachments || srcAttachments.length === 0) return [];

  const CONFIG = tolerance.attachmentSize;
  const cfg = CONFIG[combination] || CONFIG.outlook_to_outlook;

  const toMap = (list) =>
    new Map(
      (list || [])
        .filter((a) => a && (a.filename || a.name))
        .map((a) => [String(a.filename || a.name).toLowerCase().trim(), Number(a.size || 0)])
    );

  const srcMap = toMap(srcAttachments);
  const dstMap = toMap(dstAttachments);

  const diffs = [];

  // For cross-platform migrations (Outlook↔Gmail), Graph API reports the full MIME-envelope size
  // (base64 content + headers), while Gmail API reports raw decoded bytes. For small files the
  // fixed header block (~150–200 B) dominates and pushes the ratio far outside the expected
  // encoding-overhead band even when the content is perfectly intact. Below this threshold the
  // ratio is unreliable; Tier B hashes are the correct check for content integrity.
  const SMALL_FILE_SRC_THRESHOLD = 2048; // bytes

  for (const [name, srcSize] of srcMap) {
    if (!dstMap.has(name)) continue; // missing file already caught by Tier A name check
    const dstSize = dstMap.get(name);
    if (srcSize === 0 && dstSize === 0) continue;

    if (srcSize === 0) {
      diffs.push({
        field: `attachmentSize:${name}`,
        ok: true,
        expected: '0 bytes (source)',
        actual: `${dstSize} bytes (destination)`,
        displaySource: '0B',
        displayDestination: `${dstSize}B`,
        severity: 'info',
        note: 'Source attachment size is 0 bytes; size ratio cannot be computed.',
      });
      continue;
    }

    // Small files: MIME header overhead (~150–200 B) makes the ratio unreliable across platforms.
    // Downgrade to 'info' — Tier B hash comparison is the authoritative check for these.
    if (
      (combination === 'outlook_to_gmail' || combination === 'gmail_to_outlook') &&
      srcSize < SMALL_FILE_SRC_THRESHOLD
    ) {
      diffs.push({
        field: `attachmentSize:${name}`,
        ok: true,
        expected: `${srcSize}B (source)`,
        actual: `${dstSize}B (destination)`,
        displaySource: `${srcSize}B`,
        displayDestination: `${dstSize}B`,
        severity: 'info',
        note:
          `Small file (source ${srcSize} B < ${SMALL_FILE_SRC_THRESHOLD} B): cross-platform size ratio is unreliable ` +
          `because the fixed MIME header block (~150–200 B) dominates. Use Tier B hash comparison to verify content.`,
      });
      continue;
    }

    const ratio = dstSize / srcSize;
    const srcMB  = (srcSize / 1048576).toFixed(2);
    const dstMB  = (dstSize / 1048576).toFixed(2);
    const diffPct = ((ratio - 1) * 100).toFixed(1);
    const sign    = ratio >= 1 ? '+' : '';

    let severity;
    let note;

    if (ratio >= cfg.infoMin && ratio <= cfg.infoMax) {
      severity = 'info';
      note = `${cfg.expectedNote} Ratio: ${ratio.toFixed(3)} (${sign}${diffPct}%).`;
    } else if (ratio >= cfg.warnMin && ratio <= cfg.warnMax) {
      severity = 'warning';
      note =
        `Attachment size ratio ${ratio.toFixed(3)} (${sign}${diffPct}%) is outside the expected range ` +
        `[${cfg.infoMin}–${cfg.infoMax}]. ${cfg.expectedNote} ` +
        `Recommend Tier B hash comparison to confirm content integrity.`;
    } else {
      severity = 'error';
      note =
        `Attachment size ratio ${ratio.toFixed(3)} (${sign}${diffPct}%) is far outside the expected range — ` +
        `possible truncation or corruption. ${cfg.expectedNote}`;
    }

    diffs.push({
      field: `attachmentSize:${name}`,
      ok: severity !== 'error',
      expected: `${srcSize}B (${srcMB} MB) [source]`,
      actual: `${dstSize}B (${dstMB} MB) [destination]`,
      displaySource: `${srcSize}B`,
      displayDestination: `${dstSize}B`,
      sizeRatio: ratio.toFixed(3),
      combination,
      severity,
      note,
    });
  }

  return diffs;
}

/**
 * Compare Outlook isRead vs Gmail UNREAD label (Outlook→Gmail).
 * srcIsRead=true  → UNREAD should be absent at dest.
 * srcIsRead=false → UNREAD should be present at dest.
 */
function compareOutlookReadToGmailUnread(srcIsRead, gmailLabelIds) {
  if (typeof srcIsRead !== 'boolean') return [];
  const labels = Array.isArray(gmailLabelIds) ? gmailLabelIds : [];
  const destIsUnread = labels.includes('UNREAD');
  const srcIsUnread = !srcIsRead;
  if (srcIsUnread === destIsUnread) return [];
  return [{
    field: 'readState',
    ok: false,
    expected: srcIsUnread ? 'unread (UNREAD label present)' : 'read (no UNREAD label)',
    actual: destIsUnread ? 'unread (has UNREAD label)' : 'read (no UNREAD label)',
    displaySource: srcIsUnread ? 'unread' : 'read',
    displayDestination: destIsUnread ? 'unread' : 'read',
    severity: 'warning',
  }];
}

/**
 * Compare Gmail UNREAD label vs Outlook isRead (Gmail→Outlook).
 */
function compareGmailUnreadToOutlookIsRead(gmailLabelIds, destIsRead) {
  const labels = Array.isArray(gmailLabelIds) ? gmailLabelIds : [];
  const srcIsUnread = labels.includes('UNREAD');
  if (typeof destIsRead !== 'boolean') return [];
  const destIsUnread = !destIsRead;
  if (srcIsUnread === destIsUnread) return [];
  return [{
    field: 'readState',
    ok: false,
    expected: srcIsUnread ? 'unread (isRead=false)' : 'read (isRead=true)',
    actual: destIsUnread ? 'unread (isRead=false)' : 'read (isRead=true)',
    displaySource: srcIsUnread ? 'unread' : 'read',
    displayDestination: destIsUnread ? 'unread' : 'read',
    severity: 'warning',
  }];
}

/**
 * Compare Outlook isRead vs Outlook isRead (Outlook→Outlook).
 */
function compareReadState(srcIsRead, destIsRead) {
  if (typeof srcIsRead !== 'boolean' || typeof destIsRead !== 'boolean') return [];
  if (srcIsRead === destIsRead) return [];
  return [{
    field: 'readState',
    ok: false,
    expected: srcIsRead ? 'read' : 'unread',
    actual: destIsRead ? 'read' : 'unread',
    displaySource: srcIsRead ? 'read' : 'unread',
    displayDestination: destIsRead ? 'read' : 'unread',
    severity: 'warning',
  }];
}

/**
 * Compare Outlook flag state vs Gmail STARRED label (Outlook→Gmail).
 * Outlook flags are three-state: notFlagged / flagged / complete. Gmail has only STARRED, so a
 * mail that was EVER flagged — whether the follow-up is still active ('flagged') or has been marked
 * done ('complete') — correctly migrates to STARRED. Only 'notFlagged' should be un-starred.
 */
function compareOutlookFlagToGmailStarred(srcFlagStatus, gmailLabelIds) {
  const labels = Array.isArray(gmailLabelIds) ? gmailLabelIds : [];
  const status = String(srcFlagStatus || '').toLowerCase();
  const srcFlagged = status === 'flagged' || status === 'complete';
  const destStarred = labels.includes('STARRED');
  if (srcFlagged === destStarred) return [];
  if (srcFlagged && !destStarred) {
    return [{
      field: 'flag',
      ok: false,
      expected: 'STARRED (flagged at Outlook source)',
      actual: 'not starred',
      displaySource: 'flagged',
      displayDestination: 'not starred',
      severity: 'warning',
    }];
  }
  // destStarred but source not flagged — Gmail may auto-star; treat as info-warning
  return [{
    field: 'flag',
    ok: false,
    expected: 'not starred (source not flagged)',
    actual: 'STARRED',
    displaySource: String(srcFlagStatus || 'notFlagged'),
    displayDestination: 'STARRED',
    severity: 'warning',
  }];
}

/**
 * Compare Outlook flag states (Outlook→Outlook).
 */
function compareFlagState(srcFlag, destFlag, severity = 'warning') {
  const s = String(srcFlag?.flagStatus || srcFlag || 'notFlagged').toLowerCase();
  const d = String(destFlag?.flagStatus || destFlag || 'notFlagged').toLowerCase();
  if (s === d) return [];
  return [{
    field: 'flag',
    ok: false,
    expected: s,
    actual: d,
    displaySource: s,
    displayDestination: d,
    severity,
  }];
}

/**
 * Compare Outlook importance vs Gmail IMPORTANT label (Outlook→Gmail).
 * Only warns when source is 'high' and IMPORTANT is absent — Gmail auto-applies IMPORTANT via ML
 * so presence on non-high messages is expected and not flagged.
 */
function compareOutlookImportanceToGmailImportant(srcImportance, gmailLabelIds) {
  const labels = Array.isArray(gmailLabelIds) ? gmailLabelIds : [];
  const srcHigh = String(srcImportance || '').toLowerCase() === 'high';
  if (!srcHigh) return [];
  const destImportant = labels.includes('IMPORTANT');
  if (destImportant) return [];
  return [{
    field: 'importance',
    ok: false,
    expected: 'IMPORTANT (high importance at Outlook source)',
    actual: 'not important',
    displaySource: 'high',
    displayDestination: 'not important',
    severity: 'warning',
  }];
}

/**
 * Compare importance values (Outlook→Outlook).
 */
function compareImportanceOutlookToOutlook(srcImportance, destImportance, severity = 'warning') {
  const s = String(srcImportance || 'normal').toLowerCase();
  const d = String(destImportance || 'normal').toLowerCase();
  if (s === d) return [];
  return [{
    field: 'importance',
    ok: false,
    expected: s,
    actual: d,
    displaySource: s,
    displayDestination: d,
    severity,
  }];
}

/**
 * Compare sensitivity values (Outlook→Outlook): normal | personal | private | confidential.
 * Sensitivity is a compliance-relevant property, so a mismatch is an 'error' (real bug) by default.
 */
function compareSensitivityOutlookToOutlook(srcSensitivity, destSensitivity, severity = 'error') {
  const s = String(srcSensitivity || 'normal').toLowerCase();
  const d = String(destSensitivity || 'normal').toLowerCase();
  if (s === d) return [];
  return [{
    field: 'sensitivity',
    ok: false,
    expected: s,
    actual: d,
    displaySource: s,
    displayDestination: d,
    severity,
  }];
}

/**
 * Compare sent timestamps between source and destination.
 * Parses both ISO 8601 and RFC 2822 (Gmail Date header) formats.
 * Uses 'warning' severity — some platforms re-stamp on import.
 *
 * @param {string|number|null} srcDate source sentDateTime (ISO string, RFC 2822, or epoch ms)
 * @param {string|number|null} destDate destination sentDateTime (ISO string, RFC 2822, or epoch ms)
 * @param {number} toleranceMs allowed delta in ms before flagging (default: 300000 = 5 min)
 */
function compareSentDateTime(srcDate, destDate, toleranceMs = 300000) {
  const toMs = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const parsed = Date.parse(String(v));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const srcMs = toMs(srcDate);
  const dstMs = toMs(destDate);
  if (srcMs == null || dstMs == null) return [];
  const deltaMs = Math.abs(srcMs - dstMs);
  if (deltaMs <= toleranceMs) return [];
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  const deltaMins = Math.round(deltaMs / 60000);
  return [{
    field: 'sentDateTime',
    ok: false,
    expected: fmt(srcMs),
    actual: fmt(dstMs),
    displaySource: fmt(srcMs),
    displayDestination: `${fmt(dstMs)} (Δ ${deltaMins >= 1440 ? `${Math.round(deltaMins / 1440)}d` : `${deltaMins}m`})`,
    severity: 'warning',
  }];
}

// ── Mailbox size validation ───────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Per-combination tolerance for total mailbox size ratio (dst / src).
// Bands live in ./mailTolerance/<combination>.js (one file per combination).
const MAILBOX_SIZE_CONFIG = tolerance.mailboxSize;

/**
 * Build a structured mailbox size comparison result.
 * @param {{ sizeBytes: number, messageCount: number, partial?: boolean, method?: string }} src
 * @param {{ sizeBytes: number, messageCount: number, partial?: boolean, method?: string }} dst
 * @param {'outlook_to_gmail'|'gmail_to_outlook'|'outlook_to_outlook'|'gmail_to_gmail'} combination
 */
function buildMailboxSizeValidation(src, dst, combination) {
  const cfg = MAILBOX_SIZE_CONFIG[combination] || MAILBOX_SIZE_CONFIG['gmail_to_outlook'];
  const srcBytes = Number(src?.sizeBytes) || 0;
  const dstBytes = Number(dst?.sizeBytes) || 0;
  const ratio = srcBytes > 0 ? dstBytes / srcBytes : null;
  const diffBytes = dstBytes - srcBytes;
  const diffPct = srcBytes > 0 ? Math.round((diffBytes / srcBytes) * 100) : null;

  let severity = 'info';
  let statusLabel = 'Expected';
  if (ratio !== null) {
    if (ratio < cfg.warnMin || ratio > cfg.warnMax) {
      severity = 'error';
      statusLabel = `Anomaly (${diffPct != null ? (diffPct >= 0 ? '+' : '') + diffPct + '%' : 'N/A'})`;
    } else if (ratio < cfg.infoMin || ratio > cfg.infoMax) {
      severity = 'warning';
      statusLabel = `Notable (${diffPct != null ? (diffPct >= 0 ? '+' : '') + diffPct + '%' : 'N/A'})`;
    } else {
      statusLabel = `Expected (${diffPct != null ? (diffPct >= 0 ? '+' : '') + diffPct + '%' : '0%'})`;
    }
  }

  return {
    available: true,
    sourceSizeBytes: srcBytes,
    destSizeBytes: dstBytes,
    sourceSizeHuman: formatBytes(srcBytes) + (src?.partial ? ' (partial)' : ''),
    destSizeHuman: formatBytes(dstBytes) + (dst?.partial ? ' (partial)' : ''),
    sourceMessageCount: src?.messageCount ?? null,
    destMessageCount: dst?.messageCount ?? null,
    sizeRatio: ratio,
    diffBytes,
    diffPercent: diffPct,
    combination,
    severity,
    statusLabel,
    note: cfg.note,
    srcMethod: src?.method,
    dstMethod: dst?.method,
  };
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
  buildMailboxSizeValidation,
};
