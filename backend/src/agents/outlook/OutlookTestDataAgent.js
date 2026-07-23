/**
 * OutlookTestDataAgent
 *
 * Creates test email data in an Outlook/Microsoft 365 mailbox via Microsoft
 * Graph API — mirrors GmailTestDataAgent but targets Outlook folders.
 *
 * Test data source (priority order):
 *   1. Custom test cases from backend/data/custom-test-cases.json (Agent Repo)
 *   2. Built-in fallback messages when the file is empty or missing
 *
 * Folder mapping (tc.folder → Graph API well-known name):
 *   Inbox / INBOX          → inbox
 *   Sent / Sent Items      → sentitems
 *   Draft / Drafts         → drafts
 *   Spam / Junk Email      → junkemail
 *   Trash / Deleted Items  → deleteditems
 *   Archive                → archive
 *   anything else          → custom folder created via Graph API
 *
 * Migration type semantics
 * ──────────────────────────────────────────────────────────────────────────────
 * ONE-TIME (FULL): Initial migration — transfers all existing mailbox data.
 *   Creates: emails in all default + custom folders, Microsoft 365 Groups.
 *
 * DELTA: Transfers only newly added or modified data after the One-Time run.
 *   Creates: incremental emails (all default + custom folders), Contacts,
 *   Calendar events (including shared calendar).
 *   Contacts and Calendars travel with the incremental mail sweep — they are
 *   treated as new/modified items added after the one-time migration.
 *
 * E2E extended scenarios (when testType === 'E2E'):
 *   One-Time + DELTA (sections 1-21):
 *   - Archive folder messages (2)
 *   - Flagged + high-importance messages (→ Gmail STARRED/IMPORTANT)
 *   - Large attachment message (>25 MB, requires ENABLE_LARGE_ATTACHMENT_TEST=true)
 *   - Threaded email chain (3-message thread)
 *   - Categorized message (Red Category)
 *   - System folder emails: Sent Items→SENT, Drafts→DRAFT, Junk→SPAM, Deleted→TRASH
 *   - HTML rich content email (bold, italic, lists, links, colors)
 *   - Email with single PDF attachment
 *   - Email with multiple attachments (2 text files)
 *   - Email with CC recipients
 *   - Custom folder emails (QA-Migration-Folder, QA-Work-Projects, QA-Client-Emails)
 *   - Low importance email
 *   - Multiple categories email (Red + Blue Category)
 *   - Unicode/emoji subject email
 *   - HTML email with inline image
 *   - Additional inbox variants (BCC, FW:, multiple TO, special chars, emoji, long subject)
 *   - Additional sent, draft, junk, deleted variants
 *   - Microsoft 365 Groups (1 public + 1 private)
 *   - Moved-to-folder: 2 Inbox + 2 Sent emails created then moved into QA-Moved-From-Inbox-Sent
 *   - Historical email: old sentDateTime (2019) in Inbox and Sent Items
 *   - Sensitivity labels: confidential and private sensitivity emails
 *   - Reply-To header: replyTo differs from From
 *   - Empty subject email
 *   - Completed flag (third Outlook flag state)
 *   - Sent email moved to custom folder (QA-Sent-To-Custom)
 *   - Parent+child folder: emails at both parent (QA-Parent-With-Sub) and child level
 *   - Large body email (~50 KB)
 *   - Many TO recipients (10+)
 *   - Mixed-language body (Latin + Cyrillic + CJK + Arabic)
 *   - Draft with no recipients
 *   - ICS attachment email (meeting invite as mail item)
 *   - Large body email standalone (~50 KB, subject: QA E2E - Large Body Email (~50KB))
 *   - Draft with no recipients standalone (empty To/CC/BCC, subject: QA E2E - Draft With No Recipients)
 *   - DOCX attachment email (minimal valid DOCX, subject: QA E2E - DOCX Attachment Test)
 *   - Shared mailbox (section 46): seeds real content into SHARED_MAILBOX_ADDRESS when set
 *     (Graph app-only), else falls back to a From-header simulation
 *   - Real distribution list: mail-enabled group + members created (section 21b), email sent
 *     THROUGH the group with live fan-out + direct-inject fallback (section 47)
 *   - Signature in body email (HTML signature block at bottom, section 48)
 *
 *   DELTA only (sections D-Cal, D-Cal-Single, D-Cal-Delegate, D-Cal-Busy, D-SharedCal, D-Contacts, D-Contacts-Partial, D1-D8):
 *   - Calendar events: past, all-day, future, weekly recurring, multi-day,
 *     with attendees, with description, shared calendar
 *   - Single instance calendar event (non-recurring, subject: QA E2E - Single Instance Calendar Event)
 *   - Calendar delegate event marker (showAs subject: QA E2E - Calendar Delegate Event Test)
 *   - Busy status calendar event (showAs=busy, subject: QA E2E - Busy Status Calendar Event)
 *   - Contacts (6 one-time-equivalent + 3 new delta contacts + 1 partial contact name+email only)
 *   - New incremental emails in all default + custom folders
 */

const path  = require('path');
const fs    = require('fs');
const zlib  = require('zlib');
const crypto = require('crypto');
const axios = require('axios');
const XLSX_LIB = require('xlsx');

/**
 * Build a genuinely large, VALID .xlsx of roughly `targetMb` by filling cells with random
 * (incompressible) base64 data so the zipped workbook actually reaches the target size —
 * used for the "large file → OneDrive link" test cases (a tiny placeholder file would make
 * the shared link resolve to a few KB instead of the advertised size).
 * Cells stay under Excel's 32,767-char limit so the file still opens in Excel.
 */
function makeLargeXlsxBuffer(targetMb, metaRows = []) {
  const targetBytes = Math.round(targetMb * 1024 * 1024);
  // base64-of-random is ~incompressible, so the zipped xlsx ≈ the base64 payload length.
  // base64 expands raw bytes by 4/3, so raw ≈ target × 0.75; use 0.78 for a small margin over target.
  const rawBytes = Math.ceil(targetBytes * 0.78);
  const payload = crypto.randomBytes(rawBytes).toString('base64');
  const CELL = 30000;   // < Excel's 32,767 char/cell limit → workbook stays valid/openable
  const PER_ROW = 8;
  const rows = metaRows.slice();
  let row = [];
  for (let i = 0; i < payload.length; i += CELL) {
    row.push(payload.slice(i, i + CELL));
    if (row.length === PER_ROW) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  const wb = XLSX_LIB.utils.book_new();
  XLSX_LIB.utils.book_append_sheet(wb, XLSX_LIB.utils.aoa_to_sheet(rows), 'QA');
  const out = XLSX_LIB.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
const { BaseAgent }    = require('../core/BaseAgent');
const outlookClient    = require('../../clients/outlookClient');
const env              = require('../../config/env');
const logger           = require('../../utils/logger');
const executionService = require('../../services/executionService');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Minimal valid PDF (556 bytes) — correct xref offsets, renders one page with text.
const MINIMAL_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+ID4+ID4+ID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNTMgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAxMDAgNzAwIFRkIChRQSBNaWdyYXRpb24gVGVzdCBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjkwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNSAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMzkzCiUlRU9GCg==';

// Minimal valid DOCX (~1 KB) — proper ZIP/OpenXML container, opens in Word without errors.
const MINIMAL_DOCX_B64 = 'UEsDBBQAAAAIAIkMtFx5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAiQy0XJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAIkMtFzp+cGTewAAAJsAAAAcAAAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc1XMQQ4CIQyF4auQ7h3QhTEGmJ0HMHqAZqYCkSmEEqO3l6UuX/68z87vLasXNUmFHewnA4p4KWvi4OB+u+xOoKQjr5gLk4MPCczeXiljHxeJqYoaBouD2Hs9ay1LpA1lKpV4lEdpG/YxW9AVlycG0gdjjrr9GuCt/kP9F1BLAwQUAAAACACJDLRc0tYU0fMAAACWAQAAEQAAAHdvcmQvZG9jdW1lbnQueG1sbZDdSsQwEIVfJeTepuuFSGl3kRXvRIUK3o5p2gaaTMiMrfv2JvEPViGcTDLMN2emPby7RawmkkXfyV1VS2G8xsH6qZPP/d3FtRTE4AdY0JtOngzJw77dmgH1mzOeRQJ4aragOzkzh0Yp0rNxQJWzOiLhyJVGp3AcrTZqwzioy3pXlyhE1IYodTuCX4HkN+4PDIPxKTdidMDpGaczgFsStr5SDqyX2eErDqd8hywxC++fbsS9nSJwGlf0hljcfs3RqpzPGouG89J+tiTSAcGl7uH4IoAZ9FzWkIwJ94NeYbFDCat/wWQ0P0ZVPj59qt+V7j8AUEsBAhQAFAAAAAgAiQy0XHluM9foAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAACACJDLRcm/036q0AAAApAQAACwAAAAAAAAAAAAAAgAEZAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAACACJDLRc6fnBk3sAAACbAAAAHAAAAAAAAAAAAAAAgAHvAQAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc1BLAQIUABQAAAAIAIkMtFzS1hTR8wAAAJYBAAARAAAAAAAAAAAAAACAAaQCAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABAAEAAMBAADGAwAAAAA=';

/** Generate a valid solid-colour PNG in base64 — size×size pixels, RGB (r,g,b). */
function makeSolidColorPng(r, g, b, size = 16) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c;
  });
  const crc32 = (buf) => {
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcB  = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
    return Buffer.concat([len, typeB, data, crcB]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; // 8-bit RGB
  const row  = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const rows = Buffer.concat(Array.from({ length: size }, () => row));
  const idat = zlib.deflateSync(rows);
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

/** Add a OneDrive reference attachment to an existing message (isDraft=false OK). */
async function addReferenceAttachment(userEmail, graphMessageId, { name, sourceUrl, sizeMbLabel }) {
  const token = await outlookClient.getAccessToken(userEmail);
  const uid   = encodeURIComponent(String(userEmail).trim());
  await axios.post(
    `${GRAPH_BASE}/users/${uid}/messages/${graphMessageId}/attachments`,
    {
      '@odata.type': '#microsoft.graph.referenceAttachment',
      name,
      sourceUrl,
      providerType: 'oneDriveBusiness',
      permission: 'view',
      isFolder: false,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
}

// ── Folder mapping ────────────────────────────────────────────────────────────

const FOLDER_MAP = {
  inbox:           'inbox',
  sent:            'sentitems',
  'sent items':    'sentitems',
  draft:           'drafts',
  drafts:          'drafts',
  spam:            'junkemail',
  'junk email':    'junkemail',
  trash:           'deleteditems',
  'deleted items': 'deleteditems',
  archive:         'archive',
  // Gmail label IDs → Outlook well-known
  inbox_label:  'inbox',
  sent_label:   'sentitems',
  draft_label:  'drafts',
  spam_label:   'junkemail',
  trash_label:  'deleteditems',
};

const LABEL_TO_FOLDER = {
  INBOX:  'inbox',
  SENT:   'sentitems',
  DRAFT:  'drafts',
  SPAM:   'junkemail',
  TRASH:  'deleteditems',
};

/** Resolve a test case's folder/labelIds to a Graph API folder id or well-known name. */
function resolveFolderId(tc) {
  if (tc.folder) {
    const key = tc.folder.trim().toLowerCase();
    if (FOLDER_MAP[key]) return FOLDER_MAP[key];
  }
  if (Array.isArray(tc.labelIds) && tc.labelIds.length > 0) {
    const label = tc.labelIds[0];
    if (LABEL_TO_FOLDER[label]) return LABEL_TO_FOLDER[label];
  }
  return 'inbox';
}

// ── Test case loading ─────────────────────────────────────────────────────────

const SAMPLE_ATTACHMENT = Buffer.from('Sample QA attachment for migration testing').toString('base64');

const FALLBACK_CASES = [
  { subject: 'QA Smoke - Plain Text Email',    textBody: 'Plain text test email for migration QA.',       folder: 'Inbox', labelIds: ['INBOX'], isRead: true  },
  { subject: 'QA Smoke - Read State Test',     textBody: 'Read state validation test email.',             folder: 'Inbox', labelIds: ['INBOX'], isRead: true  },
  { subject: 'QA Smoke - Sender Visibility',   textBody: 'External sender visibility test.',              folder: 'Inbox', labelIds: ['INBOX'], isRead: false },
  { subject: 'QA Smoke - Count Verification',  textBody: 'Email count verification after migration.',     folder: 'Inbox', labelIds: ['INBOX'], isRead: false },
  { subject: 'QA Smoke - Unread State Test',   textBody: 'Unread state validation test email.',           folder: 'Inbox', labelIds: ['INBOX'], isRead: false },
];

/**
 * SMOKE tier: 10 essential cases for a quick QA check.
 * Covers all critical folder types + key mail attributes in one fast run.
 */
const SMOKE_CASES = [
  { subject: 'QA Smoke - Inbox Basic',         textBody: 'Basic inbox email migration check.',                          folder: 'Inbox',        isRead: true  },
  { subject: 'QA Smoke - Inbox Unread',        textBody: 'Unread inbox email migration check.',                         folder: 'Inbox',        isRead: false },
  { subject: 'QA Smoke - Inbox Attachment',    textBody: 'Inbox email with attachment.',                                 folder: 'Inbox',        isRead: true,
    attachments: [{ name: 'smoke-test.txt', contentType: 'text/plain', content: 'U21va2UgUUEgZmlsZQ==' }] },
  { subject: 'QA Smoke - Inbox Flagged',       textBody: 'Flagged inbox email (maps to Starred in Gmail).',             folder: 'Inbox',        isRead: true,
    flag: { flagStatus: 'flagged' } },
  { subject: 'QA Smoke - Inbox High Priority', textBody: 'High importance email migration check.',                      folder: 'Inbox',        isRead: false,
    importance: 'high' },
  { subject: 'QA Smoke - Sent Items',          textBody: 'Sent items folder migration check.',                          folder: 'Sent Items',   isRead: true  },
  { subject: 'QA Smoke - Drafts',              textBody: 'Draft email migration check.',                                folder: 'Drafts',       isRead: false },
  { subject: 'QA Smoke - Junk Email',          textBody: 'Junk/Spam folder migration check.',                           folder: 'Junk Email',   isRead: false },
  { subject: 'QA Smoke - Deleted Items',       textBody: 'Deleted items (Trash) migration check.',                      folder: 'Deleted Items',isRead: true  },
  { subject: 'QA Smoke - Custom Folder',       textBody: 'Custom folder migration check.',                              folder: 'QA-Smoke-Folder', isRead: true },
];

/**
 * SANITY tier: ~20 messages covering all key folder types + marker states.
 * Designed to be a superset of SMOKE (5 msgs) with broader folder + state coverage.
 */
const SANITY_CASES = [
  // Inbox — read / unread
  { subject: 'QA Sanity - Inbox Read',           textBody: 'Inbox read message sanity check.',            folder: 'Inbox',         isRead: true  },
  { subject: 'QA Sanity - Inbox Unread',          textBody: 'Inbox unread message sanity check.',          folder: 'Inbox',         isRead: false },
  { subject: 'QA Sanity - Inbox With Attachment', textBody: 'Inbox message with attachment.',              folder: 'Inbox',         isRead: true,
    attachments: [{ name: 'qa-sanity.txt', contentType: 'text/plain', content: 'U2FuaXR5IFFBIGZpbGU=' }] },
  { subject: 'QA Sanity - Inbox CC Recipients',   textBody: 'Message with CC recipients.',                 folder: 'Inbox',         isRead: true  },
  { subject: 'QA Sanity - Inbox Flagged',         textBody: 'Flagged inbox message (STARRED in Gmail).',   folder: 'Inbox',         isRead: true,
    flag: { flagStatus: 'flagged' } },
  { subject: 'QA Sanity - Inbox High Importance', textBody: 'High importance inbox message.',              folder: 'Inbox',         isRead: false,
    importance: 'high' },
  // Sent Items
  { subject: 'QA Sanity - Sent Items',            textBody: 'Sent items sanity check.',                    folder: 'Sent Items',    isRead: true  },
  { subject: 'QA Sanity - Sent Unread',           textBody: 'Unread sent item (unusual but valid).',       folder: 'Sent Items',    isRead: false },
  // Drafts
  { subject: 'QA Sanity - Draft Message',         textBody: 'Draft message for sanity check.',             folder: 'Drafts',        isRead: false },
  // Junk Email
  { subject: 'QA Sanity - Junk Email',            textBody: 'Junk/spam message sanity check.',             folder: 'Junk Email',    isRead: false },
  // Deleted Items
  { subject: 'QA Sanity - Deleted Items',         textBody: 'Deleted items message sanity check.',         folder: 'Deleted Items', isRead: true  },
  // Archive
  { subject: 'QA Sanity - Archive',               textBody: 'Archive folder message sanity check.',        folder: 'Archive',       isRead: true  },
  { subject: 'QA Sanity - Archive Unread',        textBody: 'Unread archive folder message sanity check.', folder: 'Archive',       isRead: false },
  { subject: 'QA Sanity - Archive With Attachment', textBody: 'Archive message with attachment.',          folder: 'Archive',       isRead: true,
    attachments: [{ name: 'qa-sanity-archive.txt', contentType: 'text/plain', content: 'QXJjaGl2ZSBRQSBmaWxl' }] },
  { subject: 'QA Sanity - Archive HTML Body',
    htmlBody: '<html><body><b>Archived</b> HTML message for <a href="https://www.cloudfuze.com">sanity check</a>.</body></html>',
    folder: 'Archive',       isRead: true  },
  { subject: 'QA Sanity - Archive High Importance', textBody: 'High importance archived message.',          folder: 'Archive',       isRead: false,
    importance: 'high' },
  { subject: 'QA Sanity - Archive Flagged',       textBody: 'Flagged archive message (STARRED in Gmail).', folder: 'Archive',       isRead: true,
    flag: { flagStatus: 'flagged' } },
  // Custom folder
  { subject: 'QA Sanity - Custom Folder A',       textBody: 'Custom folder message sanity check.',         folder: 'QA-Sanity-Folder', isRead: true },
  { subject: 'QA Sanity - Custom Folder B',       textBody: 'Second message in custom folder.',            folder: 'QA-Sanity-Folder', isRead: false },
  // Additional inbox variants
  { subject: 'QA Sanity - Sender Check',          textBody: 'External sender validation.',                 folder: 'Inbox',         isRead: true  },
  { subject: 'QA Sanity - HTML Body',
    htmlBody: '<html><body><b>Bold</b> and <i>italic</i> content for <a href="https://example.com">sanity check</a>.</body></html>',
    folder: 'Inbox',   isRead: true  },
  { subject: 'QA Sanity - Low Importance',        textBody: 'Low importance message.',                     folder: 'Inbox',         isRead: true,
    importance: 'low' },
  { subject: 'QA Sanity - Category Red',          textBody: 'Message with Red Category.',                  folder: 'Inbox',         isRead: true,
    categories: ['Red Category'] },
  { subject: 'QA Sanity - Multiple TO',           textBody: 'Message addressed to multiple recipients.',   folder: 'Inbox',         isRead: true  },
  { subject: 'QA Sanity - Empty Subject',         textBody: 'Sanity check message with empty subject.',    folder: 'Inbox',         isRead: false,
    subject: '' },
];

// Smoke and Sanity are merged: a SMOKE run seeds the UNION of the built-in smoke cases and the
// (Agent-Repo or built-in) sanity cases, deduped by subject. Extended-source entries are excluded
// (handled by _createExtendedTestData for E2E). Returns [] never — always a usable case list.
function mergedSmokeCases(data, log) {
  const notExtended = (c) => c && c.source !== 'extended';
  const smokeCustom  = ((data && data.smoke)  || []).filter(notExtended);
  const sanityCustom = ((data && data.sanity) || []).filter(notExtended);
  const sanityBase   = sanityCustom.length > 0 ? sanityCustom : SANITY_CASES;
  const merged = [...SMOKE_CASES, ...smokeCustom, ...sanityBase];
  const seen = new Set();
  const deduped = merged.filter((c) => {
    const k = String(c.subject || '').toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (log) log.info(`SMOKE (merged Smoke+Sanity): ${deduped.length} case(s) — ${SMOKE_CASES.length} smoke + ${sanityBase.length} sanity (deduped)`);
  return deduped;
}

function loadTestCases(testType, log) {
  try {
    const filePath = path.resolve(__dirname, '../../../data/custom-test-cases.json');
    if (!fs.existsSync(filePath)) {
      log.warn('custom-test-cases.json not found — using built-in cases');
      return testType === 'E2E' ? FALLBACK_CASES : mergedSmokeCases(null, log);
    }
    const data  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const key   = testType.toLowerCase();
    // SANITY (merged Smoke+Sanity): union of built-in smoke cases + Agent-Repo/built-in sanity cases
    if (key === 'sanity') {
      return mergedSmokeCases(data, log);
    }
    const cases = (data[key] || []).filter(c => c.source !== 'extended');
    if (cases.length > 0) {
      log.info(`Loaded ${cases.length} custom test case(s) from Agent Repo for ${testType}`);
      return cases;
    }
    // E2E: fall back to smoke cases (comprehensive base) rather than 5 hardcoded messages.
    // The _createExtendedTestData method then adds E2E-specific scenarios on top.
    if (key === 'e2e' && (data.smoke || []).length > 0) {
      log.warn(`No e2e test cases in Agent Repo — falling back to smoke cases as E2E base (${data.smoke.length} cases)`);
      return data.smoke;
    }
    log.warn(`No ${testType} test cases in Agent Repo — using fallback messages`);
    return FALLBACK_CASES;
  } catch (e) {
    log.warn(`Failed to load test cases: ${e.message} — using fallback`);
    return testType === 'E2E' ? FALLBACK_CASES : mergedSmokeCases(null, log);
  }
}

// ── Message builder ───────────────────────────────────────────────────────────

/**
 * Per-domain static user lists — checked BEFORE OUTLOOK_ACCOUNTS env config.
 * internal: same-domain users; external: cross-domain senders.
 */
const OUTLOOK_DOMAIN_USERS = {
  'qatestagent.com': {
    internal: ['Alex@qatestagent.com', 'ben@qatestagent.com', 'dan@qatestagent.com', 'ron@qatestagent.com', 'Blueteam1@qatestagent.com', 'Blueteam2@qatestagent.com', 'Blueteam3@qatestagent.com'],
    external: ['mia@pepperwood.club', 'oilver@pepperwood.club', 'sophia@pepperwood.club'],
  },
  'gajha.com': {
    internal: ['alex@gajha.com', 'mia@gajha.com', 'harry@gajha.com', 'Taylor@gajha.com', 'Martin@gajha.com', 'Wilson@gajha.com', 'Clark@gajha.com', 'kim@gajha.com'],
    external: ['mia@pepperwood.club', 'oilver@pepperwood.club', 'sophia@pepperwood.club'],
  },
};

const FALLBACK_EXTERNAL_SENDERS = [
  { name: 'Mia',      address: 'mia@pepperwood.club' },
  { name: 'Oliver',   address: 'oilver@pepperwood.club' },
  { name: 'Sophia',   address: 'sophia@pepperwood.club' },
];

function toSenderObject(addressOrObj) {
  if (!addressOrObj) return null;
  if (typeof addressOrObj === 'object' && addressOrObj.address) {
    return { address: addressOrObj.address, name: addressOrObj.name || addressOrObj.address };
  }
  const address = String(addressOrObj).trim();
  if (!address || !address.includes('@')) return null;
  const localPart = address.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const name = localPart
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ') || address;
  return { address, name };
}

function buildGraphMessage(tc, index, userEmail, senderRotation) {
  const rotation = Array.isArray(senderRotation) && senderRotation.length > 0
    ? senderRotation
    : FALLBACK_EXTERNAL_SENDERS;
  const externalContact = toSenderObject(rotation[index % rotation.length]);

  const folder = (tc.folder || '').trim().toLowerCase();
  const isSent  = folder === 'sent' || folder === 'sent items' || folder === 'sentitems';
  const isDraft = folder === 'draft' || folder === 'drafts';

  const isHtml = !!tc.htmlBody;
  const body   = tc.htmlBody || tc.textBody || 'QA migration test message.';

  const msg = {
    subject:      tc.subject !== undefined ? tc.subject : `QA Test Message #${index + 1}`,
    body:         { contentType: isHtml ? 'html' : 'text', content: body },
    isRead:       tc.isRead !== undefined ? Boolean(tc.isRead) : index % 2 === 0,
    isDraft:      isDraft,
  };

  if (isSent) {
    msg.from         = { emailAddress: { address: userEmail, name: userEmail.split('@')[0] } };
    msg.toRecipients = [{ emailAddress: externalContact }];
  } else {
    msg.from         = { emailAddress: externalContact };
    msg.toRecipients = [{ emailAddress: { address: userEmail, name: userEmail.split('@')[0] } }];
  }

  // Pass-through optional fields from test case
  if (tc.importance) msg.importance = tc.importance;
  if (tc.flag) msg.flag = tc.flag;
  if (tc.categories) msg.categories = tc.categories;
  if (Array.isArray(tc.attachments) && tc.attachments.length > 0) {
    msg.attachments = tc.attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: a.content || Buffer.from(a.name).toString('base64'),
    }));
  }

  return msg;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

class OutlookTestDataAgent extends BaseAgent {
  constructor() {
    super('OutlookTestDataAgent');
  }

  async execute(context) {
    const log       = logger.child({ agent: this.name, executionId: context.executionId });
    const userEmail = context.sourceEmail;
    const testType  = (context.testType || 'SMOKE').toUpperCase();

    log.info(`Starting — testType=${testType}  user=${userEmail}`);

    const userDomain = (userEmail.split('@')[1] || '').toLowerCase();
    const staticDomainMap = OUTLOOK_DOMAIN_USERS[userDomain];
    let senderRotation;
    if (staticDomainMap) {
      const internal = staticDomainMap.internal.filter((e) => e.toLowerCase() !== userEmail.toLowerCase());
      const external = staticDomainMap.external || [];
      senderRotation = [...internal, ...external];
      log.info(`Using static domain map for ${userDomain}: ${internal.length} internal + ${external.length} external senders`);
    } else {
      senderRotation = typeof env.buildOutlookInboundSenders === 'function'
        ? env.buildOutlookInboundSenders(userEmail)
        : [];
      if (senderRotation.length > 0) {
        log.info(`Inbound senders (OUTLOOK_ACCOUNTS, insert-only): ${senderRotation.join(', ')}`);
      } else {
        log.warn('OUTLOOK_ACCOUNTS is empty or contains only the source user — falling back to fake external senders');
      }
    }

    const summary = {
      testType,
      userEmail,
      messagesCreated: 0,
      foldersPopulated: [],
      inboundSenders: senderRotation,
      contactsCreated: 0,
      calendarEventsCreated: 0,
      groupsCreated: 0,
      errors: [],
    };

    // Load and create messages from test cases
    const testCases = loadTestCases(testType, log);
    log.info(`Creating ${testCases.length} message(s) in Outlook…`);

    const customFolderCache = {};

    // Pre-create all unique custom folders sequentially (avoids race conditions)
    for (const tc of testCases) {
      const folderId = resolveFolderId(tc);
      if (!Object.values(FOLDER_MAP).includes(folderId) && !customFolderCache[folderId]) {
        try {
          customFolderCache[folderId] = await outlookClient.getOrCreateMailFolder(userEmail, folderId);
        } catch (err) {
          log.warn(`Could not create custom folder "${folderId}": ${err.message} — placing in Inbox`);
          customFolderCache[folderId] = 'inbox';
        }
      }
    }

    // Create messages in parallel batches of 5 for speed
    const BATCH_SIZE = 5;
    for (let b = 0; b < testCases.length; b += BATCH_SIZE) {
      if (context.executionId && executionService.isCancelled(context.executionId)) {
        log.info('Data creation cancelled by user');
        break;
      }

      const batch = testCases.slice(b, b + BATCH_SIZE);
      await Promise.all(batch.map(async (tc, idx) => {
        const i = b + idx;
        let folderId = resolveFolderId(tc);
        const folderDisplay = tc.folder || folderId;
        if (!Object.values(FOLDER_MAP).includes(folderId)) {
          folderId = customFolderCache[folderId] || 'inbox';
        }
        try {
          const msgBody = buildGraphMessage(tc, i, userEmail, senderRotation);
          await outlookClient.createMessageInFolder(userEmail, folderId, msgBody);
          summary.messagesCreated++;
          if (!summary.foldersPopulated.includes(folderDisplay)) {
            summary.foldersPopulated.push(folderDisplay);
          }
          log.info(`✓ [${i + 1}/${testCases.length}] "${tc.subject}" → ${folderDisplay}`);
        } catch (err) {
          log.error(`✗ [${i + 1}] "${tc.subject}": ${err.message}`);
          summary.errors.push(`${tc.subject}: ${err.message}`);
        }
      }));

      if (context.executionId) {
        executionService.update(context.executionId, {
          progress: `OutlookTestDataAgent: ${summary.messagesCreated}/${testCases.length} messages created…`,
        });
      }
    }

    // SANITY (merged Smoke+Sanity): seed ONE inbox rule + a few Archive-folder mails, so "Migrate
    // Rules" and "Archive Mailbox" are exercised. These run in the flow (not from the case list),
    // so they seed even when the Agent Repo supplies custom cases. The full sets are E2E-only.
    if (testType === 'SANITY') {
      await this._createSanityRule(userEmail, summary, log, senderRotation);
      await this._createSanityArchiveMails(userEmail, summary, log, senderRotation);
    }

    // E2E extended scenarios
    if (testType === 'E2E') {
      await this._createExtendedTestData(userEmail, context, summary, log, senderRotation);
    }

    // Cap Inbox unread count — seeding marks many messages unread; keep only a realistic few.
    try {
      const cap = env.OUTLOOK_INBOX_MAX_UNREAD;
      const capResult = await outlookClient.capInboxUnread(userEmail, cap);
      if (capResult.markedRead > 0) {
        log.info(
          `Inbox unread capped to ${cap}: ${capResult.unreadBefore} → ${capResult.unreadAfter} unread ` +
          `(${capResult.markedRead} marked read, of ${capResult.total} inbox messages)`
        );
      }
      summary.inboxUnread = capResult.unreadAfter;
    } catch (capErr) {
      log.warn(`Inbox unread cap failed (non-fatal): ${capErr.message}`);
    }

    const ok = summary.errors.length === 0;
    log.info(
      `Done — ${summary.messagesCreated} messages, ${summary.contactsCreated} contacts, ` +
      `${summary.calendarEventsCreated} calendar events, ${summary.groupsCreated} groups` +
      (ok ? '' : `, ${summary.errors.length} error(s)`)
    );

    return summary;
  }

  /**
   * Extended test data for E2E runs.
   * Sections 1-21 (One-Time + DELTA): emails in all folders + M365 Groups.
   * DELTA only: Calendar events, Shared calendar, Contacts, incremental emails (D1-D8).
   * Delta migration transfers only newly added/modified data after the one-time run.
   * Contacts and calendars migrate together with incremental mail in the delta sweep.
   */
  /**
   * Deliver a test email THROUGH a real inbox rule: actually SEND it (transport) from a real
   * sender so Exchange runs the inbox rule and moves it to the target folder. A message created
   * directly in a folder via the API does NOT trigger inbox rules — only transport-delivered mail
   * does. Polls the target folder to confirm the rule routed it; if it doesn't arrive within the
   * timeout (or no real sender is available), injects it directly into the target folder so the
   * test data still exists. Returns 'rule' | 'inject'.
   */
  async _deliverThroughRule(userEmail, opts) {
    const { senderObj, targetFolderId, subject, body, contentType = 'text', isRead, attachments, canSend, log } = opts;
    const toRecipients = [{ emailAddress: { address: userEmail, name: userEmail.split('@')[0] } }];
    const sameSubj = (m) => (m.subject || '').trim() === subject.trim();

    if (canSend && senderObj && senderObj.address) {
      let sent = false;
      try {
        await outlookClient.sendMailAsUser(senderObj.address, {
          subject,
          body: { contentType, content: body },
          toRecipients,
          ...(attachments ? { attachments } : {}),
        }, false);
        sent = true;
      } catch (err) {
        log.warn(`Rule live-send failed for "${subject}": ${err.message} — injecting directly`);
      }

      if (sent) {
        // Poll the TARGET folder — confirms the rule (not just delivery) routed the message.
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const tgt = await outlookClient.listMessagesInFolderPaged(userEmail, targetFolderId, 100, 'id,subject');
            if (tgt.some(sameSubj)) return 'rule';
          } catch (_) { /* keep polling */ }
        }
        // Delivered but rule didn't route it in time: move the Inbox copy (avoids a duplicate).
        try {
          const inbox = await outlookClient.listMessagesInFolderPaged(userEmail, 'inbox', 200, 'id,subject');
          const hit = inbox.find(sameSubj);
          if (hit) {
            await outlookClient.moveMessageToFolder(userEmail, hit.id, targetFolderId);
            log.warn(`Rule did not route "${subject}" within 60s — moved the delivered copy to target`);
            return 'moved';
          }
        } catch (_) { /* fall through to inject */ }
        log.warn(`"${subject}" not found after send — injecting directly`);
      }
    }

    // Fallback: place the message directly in the target folder so the data still exists.
    await outlookClient.createMessageInFolder(userEmail, targetFolderId, {
      subject,
      body: { contentType, content: body },
      from: { emailAddress: senderObj },
      toRecipients,
      isRead: isRead !== false,
      isDraft: false,
      ...(attachments ? { attachments } : {}),
    });
    return 'inject';
  }

  /**
   * SANITY: create ONE Outlook inbox rule (From: <sender> → move to a dedicated folder) and
   * deliver a single message through it, so a SANITY run with "Migrate Rules" on has a rule
   * to migrate/validate (mirrors the E2E §24 pattern, minimal). Best-effort; never throws.
   */
  async _createSanityRule(userEmail, summary, log, senderRotation) {
    try {
      const rotation = (Array.isArray(senderRotation) && senderRotation.length > 0)
        ? senderRotation
        : (typeof env.buildOutlookInboundSenders === 'function' ? env.buildOutlookInboundSenders() : []);
      const ruleSender = toSenderObject(rotation[rotation.length - 1] || `qa.sanity.sender@${userEmail.split('@')[1]}`);
      const senderName = (ruleSender.name || ruleSender.address.split('@')[0]).replace(/\s+/g, '-');
      const folderName = `QA-Sanity-Rule-From-${senderName}`;
      const folderId   = await outlookClient.getOrCreateMailFolder(userEmail, folderName);

      const rule = await outlookClient.createInboxRule(userEmail, {
        displayName: `QA - Sanity Rule: route ${senderName} to ${folderName}`,
        sequence:    100,
        isEnabled:   true,
        conditions:  { fromAddresses: [{ emailAddress: { address: ruleSender.address, name: ruleSender.name } }] },
        actions:     { moveToFolder: folderId, stopProcessingRules: true },
      });
      log.info(`✓ SANITY rule created: "${rule.displayName}" → ${folderName}`);
      if (!summary.foldersPopulated.includes(folderName)) summary.foldersPopulated.push(folderName);

      // Deliver one message through the rule (real transport when the sender is a real account;
      // otherwise inject directly into the target folder so the data still exists).
      const canSend = rotation.length >= 1;
      const via = await this._deliverThroughRule(userEmail, {
        senderObj: ruleSender, targetFolderId: folderId,
        subject: `QA Sanity - Rule Routed Email`,
        body: `Email from ${senderName} routed to ${folderName} by an Outlook inbox rule — sanity Migrate Rules check.`,
        contentType: 'text', isRead: true, canSend, log,
      });
      summary.messagesCreated++;
      log.info(`✓ SANITY rule email (${via === 'rule' ? 'routed by rule' : 'injected'})`);
    } catch (err) {
      log.warn(`SANITY inbox rule failed (non-blocking): ${err.message}`);
      summary.errors.push(`Sanity inbox rule: ${err.message}`);
    }
  }

  /**
   * SANITY: seed a few mails into the Outlook "Archive" folder so an Outlook→Gmail sanity run
   * with "Archive Mailbox" ON has archived source mail to migrate + validate (the built-in
   * SANITY archive cases don't seed when the Agent Repo overrides them, so do it in the flow).
   * Best-effort; never throws.
   */
  async _createSanityArchiveMails(userEmail, summary, log, senderRotation) {
    const rotation = (Array.isArray(senderRotation) && senderRotation.length > 0)
      ? senderRotation.map(toSenderObject)
      : [toSenderObject(`qa.sanity.sender@${userEmail.split('@')[1]}`)];
    const pick = (i) => rotation[i % rotation.length];
    const archiveMails = [
      { subject: 'QA Sanity - Archive Read',            body: 'Archived email (read) for sanity Archive Mailbox check.', isRead: true },
      { subject: 'QA Sanity - Archive Unread',          body: 'Archived email (unread) for sanity Archive Mailbox check.', isRead: false },
      { subject: 'QA Sanity - Archive With Attachment', body: 'Archived email with attachment for sanity check.', isRead: true,
        attachments: [{ name: 'qa-sanity-archive.txt', contentType: 'text/plain', contentBytes: 'QXJjaGl2ZSBRQSBmaWxl' }] },
      { subject: 'QA Sanity - Archive HTML',            html: '<html><body><b>Archived</b> HTML for <a href="https://www.cloudfuze.com">sanity</a>.</body></html>', isRead: true },
      { subject: 'QA Sanity - Archive High Importance', body: 'High-importance archived email for sanity check.', isRead: false, importance: 'high' },
    ];
    log.info(`SANITY: creating ${archiveMails.length} Archive-folder mail(s)…`);
    for (let i = 0; i < archiveMails.length; i++) {
      const am = archiveMails[i];
      try {
        await outlookClient.createMessageInFolder(userEmail, 'archive', {
          subject: am.subject,
          body: { contentType: am.html ? 'html' : 'text', content: am.html || am.body },
          from: { emailAddress: pick(i) },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: am.isRead !== false,
          isDraft: false,
          ...(am.importance ? { importance: am.importance } : {}),
          ...(am.attachments ? { attachments: am.attachments } : {}),
        });
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes('Archive')) summary.foldersPopulated.push('Archive');
        log.info(`✓ SANITY Archive: "${am.subject}"`);
      } catch (err) {
        log.warn(`SANITY Archive mail "${am.subject}" failed: ${err.message}`);
        summary.errors.push(`Sanity archive "${am.subject}": ${err.message}`);
      }
    }
  }

  async _createExtendedTestData(userEmail, context, summary, log, senderRotation) {
    const now = new Date();

    // Sender pool — real domain accounts when OUTLOOK_ACCOUNTS is configured, fallback otherwise.
    // pick(i) rotates through the pool so different sections/emails get different senders.
    const _senderPool = (senderRotation && senderRotation.length > 0)
      ? senderRotation.map(toSenderObject)
      : FALLBACK_EXTERNAL_SENDERS.map((s) => s);
    const pick = (i) => _senderPool[i % _senderPool.length];

    const externalSender = pick(0);   // primary sender (used by most single-email sections)
    const mediumAttach = Buffer.alloc(512 * 1024, 0x41).toString('base64');

    // Real distribution-list state — set in §21 when a mail-enabled group with real members
    // can be created (requires real tenant accounts in senderRotation); consumed by §47.
    const realMemberSenders = (senderRotation && senderRotation.length > 0)
      ? senderRotation.map(toSenderObject).filter((s) => s && s.address)
      : [];
    let distributionListAddress = null;   // real group mail address (null → fall back to fixed address)
    let dlLiveSender = null;              // a real tenant member who can send TO the group

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 1. Archive folder messages ──────────────────────────────────────────
    log.info('E2E: creating Archive folder messages…');
    const archiveMessages = [
      { subject: 'QA E2E 1 - Archive Folder Test 1', body: 'Archived email for migration QA — first test.' },
      { subject: 'QA E2E 1 - Archive Folder Test 2', body: 'Archived email for migration QA — second test.' },
    ];
    for (let _i = 0; _i < archiveMessages.length; _i++) {
      const am = archiveMessages[_i];
      try {
        await outlookClient.createMessageInFolder(userEmail, 'archive', {
          subject: am.subject,
          body: { contentType: 'text', content: am.body },
          from: { emailAddress: pick(_i) },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true,
          isDraft: false,
        });
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes('Archive')) summary.foldersPopulated.push('Archive');
        log.info(`✓ Archive: "${am.subject}"`);
      } catch (err) {
        log.warn(`Archive message failed: ${err.message}`);
        summary.errors.push(`Archive "${am.subject}": ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 2. Flagged / high-importance messages ───────────────────────────────
    log.info('E2E: creating flagged and high-importance messages…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject: 'QA E2E 2 - Flagged Email Test',
        body: { contentType: 'text', content: 'This email is flagged for follow-up — migration QA.' },
        from: { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false,
        isDraft: false,
        flag: { flagStatus: 'flagged' },
      });
      summary.messagesCreated++;
      log.info('✓ Flagged email created');
    } catch (err) {
      log.warn(`Flagged message failed: ${err.message}`);
      summary.errors.push(`Flagged email: ${err.message}`);
    }

    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject: 'QA E2E 2 - High Importance Email Test',
        body: { contentType: 'text', content: 'High importance email — should appear as STARRED in Gmail.' },
        from: { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        importance: 'high',
        isRead: false,
        isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ High-importance email created');
    } catch (err) {
      log.warn(`High-importance message failed: ${err.message}`);
      summary.errors.push(`High-importance email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 3. Attachment size tests ──────────────────────────────────────────────
    // Scenario A: actual binary attachments (<25 MB and >25 MB) — "Attach as a copy"
    // Scenario B: OneDrive reference attachment — "Upload and share as a OneDrive link"
    log.info('E2E: creating attachment size test messages (20 MB and 26 MB)…');
    const _largeAttachExt = { 20: 'pdf', 26: 'pptx' };
    for (const { sizeMb, label } of [{ sizeMb: 20, label: '<25 MB (20 MB)' }, { sizeMb: 26, label: '>25 MB (26 MB)' }]) {
      try {
        const attachMsgBody = {
          subject: `QA E2E 3 - Attachment Size Test (${sizeMb} MB)`,
          body: { contentType: 'text', content: `Email with ${sizeMb} MB attachment for migration QA.` },
          from: { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false,
          isDraft: false,
        };
        await outlookClient.createMessageWithLargeAttachment(
          userEmail, 'inbox', attachMsgBody, `qa-attachment-${sizeMb}mb.${_largeAttachExt[sizeMb]}`, sizeMb
        );
        summary.messagesCreated++;
        log.info(`✓ Attachment size test created (${label})`);
      } catch (err) {
        log.warn(`Attachment size test (${label}) failed: ${err.message}`);
        summary.errors.push(`Attachment ${label}: ${err.message}`);
      }
    }

    // Scenario B: 26 MB — "Upload and share as a OneDrive link" (user chose the link option)
    // Outlook shows a dialog for files in the ~10–33 MB range. The user picked OneDrive link.
    // Exchange stores a referenceAttachment; no binary data is in the message.
    // We upload a real XLSX to the user's OneDrive and use the real share URL so the link resolves.
    // Fallback: if OneDrive is not provisioned, create the same email structure with a placeholder
    // share URL so the referenceAttachment type is still tested by CloudFuze migration.
    await (async () => {
      let shareUrl26 = null;
      try {
        const buf26 = makeLargeXlsxBuffer(26, [
          ['QA Large File', '26 MB OneDrive Link Test'],
          ['Scenario', 'User selected "Upload and share as a OneDrive link" in Outlook'],
          ['Size class', '~26 MB (user-chosen link, Outlook 10–33 MB dialog)'],
        ]);
        ({ shareUrl: shareUrl26 } = await outlookClient.uploadFileAndCreateShareLink(
          userEmail, 'qa-large-file-26mb.xlsx', buf26,
        ));
      } catch (uploadErr) {
        // OneDrive not provisioned — fall back to a placeholder URL so the referenceAttachment
        // email structure (which is what CloudFuze needs to migrate) is still created.
        log.warn(`Attachment Scenario B: OneDrive upload unavailable (${uploadErr.message}) — using placeholder URL fallback`);
        shareUrl26 = 'https://1drv.ms/x/s!QAPlaceholder-26mb-OneDriveLink';
      }
      try {
        const created3b = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
          subject: 'QA E2E 3b - Attachment OneDrive Link (26 MB)',
          body: {
            contentType: 'HTML',
            content: '<html><body>'
              + '<p>Email sharing a 26 MB file via OneDrive link — user selected '
              + '<em>"Upload and share as a OneDrive link"</em> in Outlook.</p>'
              + '<p><strong>qa-large-file-26mb.xlsx</strong> (26 MB):</p>'
              + `<p><a href="${shareUrl26}">View on OneDrive</a></p></body></html>`,
          },
          from: { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        });
        let msgId3b = created3b?.id;
        if (!msgId3b && created3b?.internetMessageId) {
          msgId3b = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'inbox', created3b.internetMessageId);
        }
        if (msgId3b) {
          await addReferenceAttachment(userEmail, msgId3b, {
            name: 'qa-large-file-26mb.xlsx',
            sourceUrl: shareUrl26,
          });
        }
        summary.messagesCreated++;
        const isFallback = shareUrl26.includes('Placeholder');
        log.info(`✓ Attachment Scenario B created (26 MB OneDrive link${isFallback ? ' — placeholder URL, no live OneDrive' : ''})`);
      } catch (err) {
        log.warn(`Attachment Scenario B failed: ${err.message}`);
        summary.errors.push(`Attachment Scenario B (OneDrive link 26MB): ${err.message}`);
      }
    })();

    // Scenario C: 35 MB — forced OneDrive link (>33 MB, Outlook gives NO "Attach as a copy" option)
    // Tests that CloudFuze migrates reference attachments created under the forced-link path,
    // where Exchange only ever stores a referenceAttachment (never a binary fileAttachment).
    // Fallback: same placeholder URL strategy as Scenario B when OneDrive is not provisioned.
    await (async () => {
      let shareUrl35 = null;
      try {
        const buf35 = makeLargeXlsxBuffer(35, [
          ['QA Large File', '35 MB Forced OneDrive Link Test'],
          ['Scenario', 'Outlook forced OneDrive link — files >33 MB have no "Attach as a copy" option'],
          ['Size class', '~35 MB (forced link path)'],
        ]);
        ({ shareUrl: shareUrl35 } = await outlookClient.uploadFileAndCreateShareLink(
          userEmail, 'qa-large-file-35mb.xlsx', buf35,
        ));
      } catch (uploadErr) {
        log.warn(`Attachment Scenario C: OneDrive upload unavailable (${uploadErr.message}) — using placeholder URL fallback`);
        shareUrl35 = 'https://1drv.ms/x/s!QAPlaceholder-35mb-ForcedOneDriveLink';
      }
      try {
        const created3c = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
          subject: 'QA E2E 3c - Attachment Forced OneDrive Link (35 MB)',
          body: {
            contentType: 'HTML',
            content: '<html><body>'
              + '<p>Email sharing a 35 MB file via OneDrive link — for files >33 MB, Outlook '
              + '<strong>does not offer "Attach as a copy"</strong>. Only the OneDrive link '
              + 'option is available.</p>'
              + '<p><strong>qa-large-file-35mb.xlsx</strong> (35 MB):</p>'
              + `<p><a href="${shareUrl35}">View on OneDrive</a></p></body></html>`,
          },
          from: { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        });
        let msgId3c = created3c?.id;
        if (!msgId3c && created3c?.internetMessageId) {
          msgId3c = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'inbox', created3c.internetMessageId);
        }
        if (msgId3c) {
          await addReferenceAttachment(userEmail, msgId3c, {
            name: 'qa-large-file-35mb.xlsx',
            sourceUrl: shareUrl35,
          });
        }
        summary.messagesCreated++;
        const isFallback = shareUrl35.includes('Placeholder');
        log.info(`✓ Attachment Scenario C created (35 MB forced OneDrive link${isFallback ? ' — placeholder URL, no live OneDrive' : ''})`);
      } catch (err) {
        log.warn(`Attachment Scenario C failed: ${err.message}`);
        summary.errors.push(`Attachment Scenario C (forced OneDrive link 35MB): ${err.message}`);
      }
    })();

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 4. Threaded email chain (3 messages) ────────────────────────────────
    // Each message carries In-Reply-To + References so Exchange groups them as
    // a proper RFC 2822 conversation thread (not just subject-based grouping).
    log.info('E2E: creating threaded email chain (direct insert, no external delivery)…');
    try {
      const threadSubject  = 'QA E2E 4 - Thread Chain Test';
      const replySubject   = `RE: ${threadSubject}`;
      const originalBody   = 'Thread original message — migration QA.';
      const reply1Body     = 'Thread reply #1 — migration QA.';
      const reply2Body     = 'Thread reply #2 (latest) — migration QA.';

      // Original: received in source inbox from externalSender
      const orig = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      threadSubject,
        body:         { contentType: 'text', content: originalBody },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
      });
      summary.messagesCreated++;
      const origMsgId = orig.internetMessageId || '';

      // Reply #1: sent by source user back to externalSender
      // In-Reply-To = original; References = original
      const reply1 = await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject:      replySubject,
        body:         { contentType: 'text', content: `${reply1Body}\n\n> ${originalBody}` },
        from:         { emailAddress: { address: userEmail, name: userEmail.split('@')[0] } },
        toRecipients: [{ emailAddress: externalSender }],
        isRead:       true, isDraft: false,
        inReplyTo:    origMsgId,
        references:   origMsgId,
      });
      summary.messagesCreated++;
      const reply1MsgId = reply1.internetMessageId || '';

      // Reply #2: received from externalSender
      // In-Reply-To = reply1; References = original + reply1
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      replySubject,
        body:         { contentType: 'text', content: `${reply2Body}\n\n> ${reply1Body}\n\n> ${originalBody}` },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead:       false, isDraft: false,
        inReplyTo:    reply1MsgId,
        references:   [origMsgId, reply1MsgId].filter(Boolean).join(' '),
      });
      summary.messagesCreated++;

      log.info('✓ Thread chain created (3 messages, properly linked via In-Reply-To/References)');
    } catch (err) {
      log.warn(`Thread chain failed: ${err.message}`);
      summary.errors.push(`Thread chain: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 5. Categorized message (Red Category) ──────────────────────────────
    log.info('E2E: creating categorized message…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 5 - Categorized Email Test',
        body:         { contentType: 'text', content: 'Email with category — migration QA.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        categories:   ['Red Category'],
        isRead:       false,
        isDraft:      false,
      });
      summary.messagesCreated++;
      log.info('✓ Categorized message created');
    } catch (err) {
      log.warn(`Categorized message failed: ${err.message}`);
      summary.errors.push(`Categorized email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 6. System folder emails (Sent Items, Drafts, Junk, Deleted Items) ──
    // These map to Gmail SENT, DRAFT, SPAM, TRASH labels — critical for Outlook→Gmail
    log.info('E2E: creating system folder emails (Sent/Draft/Junk/Deleted)…');
    const selfAddr    = { address: userEmail, name: userEmail.split('@')[0] };
    const secondSender = pick(1);
    const thirdSender  = pick(2);

    const systemFolderCases = [
      {
        folder: 'sentitems',
        label: 'Sent Items → SENT',
        msg: {
          subject:      'QA E2E 6 - Sent Items Email',
          body:         { contentType: 'text', content: 'Email in Sent Items — should migrate to Gmail SENT label.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
      },
      {
        folder: 'drafts',
        label: 'Drafts → DRAFT',
        msg: {
          subject:      'QA E2E 6 - Draft Email',
          body:         { contentType: 'text', content: 'Unsent draft — should migrate to Gmail DRAFT label.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: false, isDraft: true,
        },
      },
      {
        folder: 'junkemail',
        label: 'Junk Email → SPAM',
        msg: {
          subject:      'QA E2E 6 - Junk Email Test',
          body:         { contentType: 'text', content: 'Junk email — should migrate to Gmail SPAM label.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      },
      {
        folder: 'deleteditems',
        label: 'Deleted Items → TRASH',
        msg: {
          subject:      'QA E2E 6 - Deleted Items Email',
          body:         { contentType: 'text', content: 'Deleted email — should migrate to Gmail TRASH label.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
    ];

    for (const sc of systemFolderCases) {
      try {
        await outlookClient.createMessageInFolder(userEmail, sc.folder, sc.msg);
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes(sc.label.split(' → ')[0])) {
          summary.foldersPopulated.push(sc.label.split(' → ')[0]);
        }
        log.info(`✓ System folder (${sc.label}) email created`);
      } catch (err) {
        log.warn(`System folder (${sc.label}) failed: ${err.message}`);
        summary.errors.push(`${sc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 7. HTML rich content email ──────────────────────────────────────────
    log.info('E2E: creating HTML rich content email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 7 - HTML Rich Content Email',
        body: {
          contentType: 'html',
          content: [
            '<html><body>',
            '<h1 style="color:#1a56db">Migration QA — HTML Email</h1>',
            '<p>This email contains <b>bold text</b>, <i>italic text</i>, and <u>underlined text</u>.</p>',
            '<p>Colored paragraph: <span style="color:red">red</span>, <span style="color:green">green</span>, <span style="color:blue">blue</span>.</p>',
            '<ul><li>List item one</li><li>List item two</li><li>List item three</li></ul>',
            '<p>Link: <a href="https://example.com">Example Website</a></p>',
            '<hr/><p style="font-size:11px;color:#888">Migration QA HTML test — do not reply.</p>',
            '</body></html>',
          ].join(''),
        },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ HTML rich content email created');
    } catch (err) {
      log.warn(`HTML email failed: ${err.message}`);
      summary.errors.push(`HTML email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // Shared minimal-valid PDF bytes reused across all attachment-test sections (8, 9, 16, 17, 18, 19).
    const QA_PDF_BYTES = MINIMAL_PDF_B64;

    // ── 8. Email with single attachment ────────────────────────────────────
    log.info('E2E: creating email with single attachment…');
    try {
      const pdfBytes = QA_PDF_BYTES;
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 8 - Single Attachment (PDF)',
        body:         { contentType: 'text', content: 'Email with one PDF attachment — tests attachment migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-migration-report.pdf',
          contentType: 'application/pdf',
          contentBytes: pdfBytes,
        }],
      });
      summary.messagesCreated++;
      log.info('✓ Single attachment (PDF) email created');
    } catch (err) {
      log.warn(`Single attachment email failed: ${err.message}`);
      summary.errors.push(`Single attachment: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 9. Email with multiple attachments ─────────────────────────────────
    log.info('E2E: creating email with multiple attachments…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 9 - Multiple Attachments Email',
        body:         { contentType: 'text', content: 'Email with three attachments (TXT × 2 + PDF) — tests multi-attachment migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'qa-data-file-1.txt',
            contentType: 'text/plain',
            contentBytes: Buffer.from('QA attachment file 1 — migration test data').toString('base64'),
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'qa-data-file-2.txt',
            contentType: 'text/plain',
            contentBytes: Buffer.from('QA attachment file 2 — migration test data').toString('base64'),
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'qa-report.pdf',
            contentType: 'application/pdf',
            contentBytes: QA_PDF_BYTES,
          },
        ],
      });
      summary.messagesCreated++;
      log.info('✓ Multiple attachments email created (TXT × 2 + PDF)');
    } catch (err) {
      log.warn(`Multiple attachments email failed: ${err.message}`);
      summary.errors.push(`Multiple attachments: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 10. Email with CC recipients ────────────────────────────────────────
    log.info('E2E: creating email with CC recipients…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:       'QA E2E 10 - CC Recipients Email',
        body:          { contentType: 'text', content: 'Email with CC recipients — tests CC field migration to Gmail.' },
        from:          { emailAddress: externalSender },
        toRecipients:  [{ emailAddress: { address: userEmail } }],
        ccRecipients:  [{ emailAddress: { address: secondSender.address, name: secondSender.name } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ CC recipients email created');
    } catch (err) {
      log.warn(`CC recipients email failed: ${err.message}`);
      summary.errors.push(`CC email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 11. Custom folder email (→ custom Gmail label) ──────────────────────
    log.info('E2E: creating custom folder email…');
    try {
      const customFolderId = await outlookClient.getOrCreateMailFolder(userEmail, 'QA-Migration-Folder');
      await outlookClient.createMessageInFolder(userEmail, customFolderId, {
        subject:      'QA E2E 11 - Custom Folder Email',
        body:         { contentType: 'text', content: 'Email in a custom Outlook folder — should become a custom Gmail label.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      if (!summary.foldersPopulated.includes('QA-Migration-Folder')) {
        summary.foldersPopulated.push('QA-Migration-Folder');
      }
      log.info('✓ Custom folder email created');
    } catch (err) {
      log.warn(`Custom folder email failed: ${err.message}`);
      summary.errors.push(`Custom folder: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 12. Low importance + multiple categories ────────────────────────────
    log.info('E2E: creating low-importance and multi-category emails…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 12 - Low Importance Email',
        body:         { contentType: 'text', content: 'Low importance email — tests importance level migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        importance:   'low',
        isRead: true, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Low importance email created');
    } catch (err) {
      log.warn(`Low importance email failed: ${err.message}`);
      summary.errors.push(`Low importance: ${err.message}`);
    }

    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 12 - Multiple Categories Email',
        body:         { contentType: 'text', content: 'Email with multiple Outlook categories — tests multi-category migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        categories:   ['Red Category', 'Blue Category'],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Multiple categories email created');
    } catch (err) {
      log.warn(`Multiple categories email failed: ${err.message}`);
      summary.errors.push(`Multiple categories: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 13. Unicode / special character subject ─────────────────────────────
    log.info('E2E: creating unicode subject email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 13 - Unicode Subject: こんにちは αβγ 🎉',
        body:         { contentType: 'text', content: 'Email with unicode characters and emoji in subject — tests encoding migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Unicode subject email created');
    } catch (err) {
      log.warn(`Unicode subject email failed: ${err.message}`);
      summary.errors.push(`Unicode subject: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 14. HTML email with inline image ────────────────────────────────────
    log.info('E2E: creating HTML email with inline image…');
    try {
      // Minimal valid 1×1 white PNG (visible, non-transparent) used as inline image
      const inlinePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
      const cid = 'qa-inline-img-001@qatestagent.com';
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject: 'QA E2E 14 - Inline Image Email',
        body: {
          contentType: 'HTML',
          content: [
            '<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;">',
            '<p>This email contains an <strong>inline embedded image</strong> to test that migration tools',
            ' preserve inline attachments (Content-Disposition: inline) and their CID references.</p>',
            '<p>The image below is embedded inline via <code>cid:</code> reference:</p>',
            `<p><img src="cid:${cid}" alt="QA inline image" style="border:1px solid #ccc;padding:4px;" /></p>`,
            '<p>Validation checklist:</p>',
            '<ul>',
            '  <li>Attachment count preserved (1 inline attachment)</li>',
            '  <li>Attachment name: <em>qa-inline.png</em></li>',
            '  <li>Inline flag preserved (<code>isInline=true</code>)</li>',
            '  <li>CID reference intact in migrated body HTML</li>',
            '</ul>',
            '</body></html>',
          ].join(''),
        },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-inline.png',
          contentType: 'image/png',
          contentBytes: inlinePng,
          contentId: cid,
          isInline: true,
        }],
      });
      summary.messagesCreated++;
      log.info('✓ Inline image email created');
    } catch (err) {
      log.warn(`Inline image email failed: ${err.message}`);
      summary.errors.push(`Inline image: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 15. Additional inbox scenarios ──────────────────────────────────────
    log.info('E2E: creating additional inbox scenarios (BCC, forwarded, multiple TO, special chars)…');

    const additionalInboxCases = [
      {
        label: 'BCC recipients',
        msg: {
          subject:       'QA E2E 15 - BCC Recipients Email',
          body:          { contentType: 'text', content: 'Email with BCC — tests BCC field migration.' },
          from:          { emailAddress: externalSender },
          toRecipients:  [{ emailAddress: { address: userEmail } }],
          bccRecipients: [{ emailAddress: { address: thirdSender.address, name: thirdSender.name } }],
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Forwarded email (FW:)',
        msg: {
          subject: 'QA E2E 15 - FW: Forwarded Email Test',
          body: {
            contentType: 'html',
            content: '<html><body><p>Forwarded message — migration QA.</p><hr/>' +
              '<p><b>From:</b> original@sender.com<br/><b>Subject:</b> Original Email<br/>' +
              '<b>Date:</b> Mon, 1 Jan 2024 10:00:00 +0000</p>' +
              '<p>This is the original email content that was forwarded.</p></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Multiple TO recipients',
        msg: {
          subject:      'QA E2E 15 - Multiple TO Recipients',
          body:         { contentType: 'text', content: 'Email sent to multiple recipients — tests TO field migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [
            { emailAddress: { address: userEmail } },
            { emailAddress: { address: secondSender.address, name: secondSender.name } },
          ],
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Special chars in subject',
        msg: {
          subject:      'QA E2E 15 - Special Chars: <>&"\' Subject — Test/Check',
          body:         { contentType: 'text', content: 'Email with special characters in subject — tests encoding.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'HTML with table',
        msg: {
          subject: 'QA E2E 15 - HTML Table Content',
          body: {
            contentType: 'html',
            content: '<html><body><p>Email with HTML table:</p>' +
              '<table border="1" cellpadding="4"><tr><th>Column A</th><th>Column B</th><th>Column C</th></tr>' +
              '<tr><td>Row 1A</td><td>Row 1B</td><td>Row 1C</td></tr>' +
              '<tr><td>Row 2A</td><td>Row 2B</td><td>Row 2C</td></tr></table>' +
              '<p>End of table content.</p></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Emoji in body',
        msg: {
          subject:      'QA E2E 15 - Emoji Body Content',
          body:         { contentType: 'text', content: 'Email body with emojis: 🎉 ✅ 📧 🔔 ⭐ 📎 🗂️ — tests emoji content migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Starred (flag + importance high)',
        msg: {
          subject:      'QA E2E 15 - Starred High-Importance Flagged',
          body:         { contentType: 'text', content: 'Email that is both flagged and high importance — should appear STARRED in Gmail.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          flag:         { flagStatus: 'flagged' },
          importance:   'high',
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Long subject line',
        msg: {
          subject:      'QA E2E 15 - Long Subject: Migration QA Test for Long Subject Lines That Exceed Normal Email Subject Length Limits',
          body:         { contentType: 'text', content: 'Email with a very long subject — tests truncation handling.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Plain text multiline body',
        msg: {
          subject:      'QA E2E 15 - Multiline Plain Text Body',
          body:         { contentType: 'text', content: 'Line 1: Introduction to migration QA test.\nLine 2: This email spans multiple lines.\nLine 3: Each line should be preserved after migration.\nLine 4: Final verification line.' },
          from:         { emailAddress: thirdSender || externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
    ];

    for (let _i = 0; _i < additionalInboxCases.length; _i++) {
      const tc = additionalInboxCases[_i];
      try {
        await outlookClient.createMessageInFolder(userEmail, 'inbox', { ...tc.msg, from: { emailAddress: pick(_i) } });
        summary.messagesCreated++;
        log.info(`✓ Additional inbox: ${tc.label}`);
      } catch (err) {
        log.warn(`Additional inbox (${tc.label}) failed: ${err.message}`);
        summary.errors.push(`Inbox ${tc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 16. Additional sent items ───────────────────────────────────────────
    log.info('E2E: creating additional sent items…');
    const additionalSentCases = [
      {
        label: 'Sent HTML formatted',
        msg: {
          subject:      'QA E2E 16 - Sent HTML Formatted Email',
          body:         { contentType: 'html', content: '<html><body><p>Sent email with <b>bold</b> and <i>italic</i> formatting.</p></body></html>' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Sent with attachment',
        msg: {
          subject:      'QA E2E 16 - Sent Email With Attachment',
          body:         { contentType: 'text', content: 'Sent email with TXT and PDF attachments — tests sent + attachment migration.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-sent-attachment.txt',
              contentType: 'text/plain',
              contentBytes: Buffer.from('QA sent attachment content').toString('base64'),
            },
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-sent-report.pdf',
              contentType: 'application/pdf',
              contentBytes: QA_PDF_BYTES,
            },
          ],
        },
      },
      {
        label: 'Sent with CC',
        msg: {
          subject:      'QA E2E 16 - Sent Email With CC',
          body:         { contentType: 'text', content: 'Sent email with CC — tests CC field in sent items.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          ccRecipients: [{ emailAddress: { address: secondSender.address, name: secondSender.name } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Sent to multiple recipients',
        msg: {
          subject:      'QA E2E 16 - Sent To Multiple Recipients',
          body:         { contentType: 'text', content: 'Sent to multiple recipients — tests bulk sent migration.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [
            { emailAddress: externalSender },
            { emailAddress: { address: secondSender.address, name: secondSender.name } },
          ],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Sent reply (Re:)',
        msg: {
          subject:      'QA E2E 16 - Re: Sent Reply Email',
          body:         { contentType: 'text', content: 'Reply to original — tests reply sent items migration.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
      },
    ];

    for (const tc of additionalSentCases) {
      try {
        await outlookClient.createMessageInFolder(userEmail, 'sentitems', tc.msg);
        summary.messagesCreated++;
        log.info(`✓ Additional sent: ${tc.label}`);
      } catch (err) {
        log.warn(`Additional sent (${tc.label}) failed: ${err.message}`);
        summary.errors.push(`Sent ${tc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 17. Additional drafts ───────────────────────────────────────────────
    log.info('E2E: creating additional draft emails…');
    const additionalDraftCases = [
      {
        label: 'Draft with HTML signature',
        msg: {
          subject:      'QA E2E 17 - Draft With HTML Signature',
          body: {
            contentType: 'html',
            content: '<html><body><p>Draft body content.</p><br/><hr/>' +
              '<p style="font-size:12px;color:#666">Best regards,<br/><b>Migration QA Tester</b><br/>qa@migrationtest.com</p></body></html>',
          },
          from:         { emailAddress: { address: userEmail } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: false, isDraft: true,
        },
      },
      {
        label: 'Draft with text formatting',
        msg: {
          subject:      'QA E2E 17 - Draft Formatted Text',
          body: {
            contentType: 'html',
            content: '<html><body>' +
              '<p><b>Bold text</b> and <i>italic text</i> and <u>underlined</u>.</p>' +
              '<p><s>Strikethrough text</s> — should be preserved.</p>' +
              '<p><span style="font-size:18px">Large text</span> and <span style="font-size:10px">small text</span>.</p>' +
              '</body></html>',
          },
          from:         { emailAddress: { address: userEmail } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: false, isDraft: true,
        },
      },
      {
        label: 'Draft with attachment',
        msg: {
          subject:      'QA E2E 17 - Draft With Attachment',
          body:         { contentType: 'text', content: 'Draft email with TXT and PDF attachments — tests draft + attachment migration.' },
          from:         { emailAddress: { address: userEmail } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: false, isDraft: true,
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-draft-file.txt',
              contentType: 'text/plain',
              contentBytes: Buffer.from('QA draft attachment').toString('base64'),
            },
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-draft-report.pdf',
              contentType: 'application/pdf',
              contentBytes: QA_PDF_BYTES,
            },
          ],
        },
      },
      {
        label: 'Draft with BCC',
        msg: {
          subject:       'QA E2E 17 - Draft With BCC',
          body:          { contentType: 'text', content: 'Draft with BCC recipient — tests BCC in drafts.' },
          from:          { emailAddress: { address: userEmail } },
          toRecipients:  [{ emailAddress: externalSender }],
          bccRecipients: [{ emailAddress: { address: thirdSender.address, name: thirdSender.name } }],
          isRead: false, isDraft: true,
        },
      },
    ];

    for (const tc of additionalDraftCases) {
      try {
        await outlookClient.createMessageInFolder(userEmail, 'drafts', tc.msg);
        summary.messagesCreated++;
        log.info(`✓ Additional draft: ${tc.label}`);
      } catch (err) {
        log.warn(`Additional draft (${tc.label}) failed: ${err.message}`);
        summary.errors.push(`Draft ${tc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 18. Additional junk / spam emails ──────────────────────────────────
    log.info('E2E: creating additional junk/spam emails…');
    const additionalJunkCases = [
      {
        label: 'Junk HTML spam-style',
        msg: {
          subject:      'QA E2E 18 - Junk HTML Spam Content',
          body: {
            contentType: 'html',
            content: '<html><body style="background:#fff000"><h2>CONGRATULATIONS! You have won!</h2>' +
              '<p style="color:red;font-size:18px">Click here to claim your prize!</p>' +
              '<p>Unsubscribe: <a href="#">link</a></p></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Junk with attachment',
        msg: {
          subject:      'QA E2E 18 - Junk Email With Attachment',
          body:         { contentType: 'text', content: 'Spam email with TXT and PDF attachments — tests junk + attachment migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-junk-file.txt',
              contentType: 'text/plain',
              contentBytes: Buffer.from('QA junk attachment content').toString('base64'),
            },
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-junk-report.pdf',
              contentType: 'application/pdf',
              contentBytes: QA_PDF_BYTES,
            },
          ],
        },
      },
      {
        label: 'Junk bulk newsletter',
        msg: {
          subject:      'QA E2E 18 - Junk Newsletter/Bulk Email',
          body: {
            contentType: 'html',
            content: '<html><body><table width="600"><tr><td><h1>Newsletter</h1>' +
              '<p>This is a bulk newsletter email — migration QA test.</p>' +
              '<p>Font styles: <b>bold</b>, <i>italic</i>, <span style="color:blue">colored</span>.</p>' +
              '<p style="font-size:10px">To unsubscribe, reply STOP.</p></td></tr></table></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Junk with inline image',
        msg: {
          subject:      'QA E2E 18 - Junk Email With Inline Image',
          body: {
            contentType: 'html',
            content: '<html><body><p>Spam with inline image.</p><img src="cid:junk-img@qa" width="1"/></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
          attachments: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'junk-pixel.png',
            contentType: 'image/png',
            contentBytes: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            contentId: 'junk-img@qa',
            isInline: true,
          }],
        },
      },
    ];

    for (let _i = 0; _i < additionalJunkCases.length; _i++) {
      const tc = additionalJunkCases[_i];
      try {
        await outlookClient.createMessageInFolder(userEmail, 'junkemail', { ...tc.msg, from: { emailAddress: pick(_i) } });
        summary.messagesCreated++;
        log.info(`✓ Additional junk: ${tc.label}`);
      } catch (err) {
        log.warn(`Additional junk (${tc.label}) failed: ${err.message}`);
        summary.errors.push(`Junk ${tc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 19. Additional deleted items ────────────────────────────────────────
    log.info('E2E: creating additional deleted items…');
    const additionalDeletedCases = [
      {
        label: 'Deleted flagged email',
        msg: {
          subject:      'QA E2E 19 - Deleted Flagged Email',
          body:         { contentType: 'text', content: 'Flagged email in Deleted Items — tests starred+deleted migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          flag:         { flagStatus: 'flagged' },
          isRead: false, isDraft: false,
        },
      },
      {
        label: 'Deleted with attachment',
        msg: {
          subject:      'QA E2E 19 - Deleted Email With Attachment',
          body:         { contentType: 'text', content: 'Deleted email with TXT and PDF attachments — tests trash + attachment migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-deleted-file.txt',
              contentType: 'text/plain',
              contentBytes: Buffer.from('QA deleted attachment').toString('base64'),
            },
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: 'qa-deleted-report.pdf',
              contentType: 'application/pdf',
              contentBytes: QA_PDF_BYTES,
            },
          ],
        },
      },
      {
        label: 'Deleted HTML email',
        msg: {
          subject:      'QA E2E 19 - Deleted HTML Email',
          body:         { contentType: 'html', content: '<html><body><p>Deleted HTML email — tests HTML in trash.</p></body></html>' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
      },
      {
        label: 'Deleted forwarded email',
        msg: {
          subject:      'QA E2E 19 - Deleted FW: Forwarded Message',
          body:         { contentType: 'text', content: 'FW: Original content — deleted forwarded email migration QA.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      },
    ];

    for (let _i = 0; _i < additionalDeletedCases.length; _i++) {
      const tc = additionalDeletedCases[_i];
      try {
        await outlookClient.createMessageInFolder(userEmail, 'deleteditems', { ...tc.msg, from: { emailAddress: pick(_i) } });
        summary.messagesCreated++;
        log.info(`✓ Additional deleted: ${tc.label}`);
      } catch (err) {
        log.warn(`Additional deleted (${tc.label}) failed: ${err.message}`);
        summary.errors.push(`Deleted ${tc.label}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 20. Additional custom folders ───────────────────────────────────────
    log.info('E2E: creating additional custom folder emails…');
    const extraFolders = [
      {
        folderName: 'QA-Work-Projects',
        emails: [
          {
            label: 'Work Projects email 1',
            msg: {
              subject:      'QA E2E 20 - Work Projects Folder Email 1',
              body:         { contentType: 'text', content: 'Custom folder email — QA-Work-Projects label in Gmail.' },
              from:         { emailAddress: externalSender },
              toRecipients: [{ emailAddress: { address: userEmail } }],
              isRead: true, isDraft: false,
            },
          },
          {
            label: 'Work Projects email 2',
            msg: {
              subject:      'QA E2E 20 - Work Projects Folder Email 2',
              body:         { contentType: 'html', content: '<html><body><p>Second email in custom Work Projects folder.</p></body></html>' },
              from:         { emailAddress: externalSender },
              toRecipients: [{ emailAddress: { address: userEmail } }],
              isRead: false, isDraft: false,
            },
          },
        ],
      },
      {
        folderName: 'QA-Client-Emails',
        emails: [
          {
            label: 'Client Emails folder email',
            msg: {
              subject:      'QA E2E 20 - Client Emails Folder Email',
              body:         { contentType: 'text', content: 'Custom folder for client emails — tests nested label hierarchy in Gmail.' },
              from:         { emailAddress: externalSender },
              toRecipients: [{ emailAddress: { address: userEmail } }],
              isRead: true, isDraft: false,
            },
          },
        ],
      },
    ];

    for (const ef of extraFolders) {
      try {
        const folderId = await outlookClient.getOrCreateMailFolder(userEmail, ef.folderName);
        for (const tc of ef.emails) {
          try {
            await outlookClient.createMessageInFolder(userEmail, folderId, tc.msg);
            summary.messagesCreated++;
            if (!summary.foldersPopulated.includes(ef.folderName)) {
              summary.foldersPopulated.push(ef.folderName);
            }
            log.info(`✓ Custom folder ${ef.folderName}: ${tc.label}`);
          } catch (err) {
            log.warn(`Custom folder ${ef.folderName} email failed: ${err.message}`);
            summary.errors.push(`${ef.folderName} ${tc.label}: ${err.message}`);
          }
        }
      } catch (err) {
        log.warn(`Could not create folder ${ef.folderName}: ${err.message}`);
        summary.errors.push(`Folder ${ef.folderName}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 21. Microsoft 365 Groups (One Time + DELTA) ──────────────────────────
    log.info('E2E: creating Microsoft 365 Groups…');
    const ts = Date.now().toString().slice(-6);
    const groups = [
      { displayName: `QA Public Group ${ts}`, mailNickname: `qa-pub-${ts}`, description: 'Public M365 group for migration QA', isPrivate: false },
      { displayName: `QA Private Group ${ts}`, mailNickname: `qa-prv-${ts}`, description: 'Private M365 group for migration QA', isPrivate: true },
    ];

    for (const grp of groups) {
      try {
        await outlookClient.createGroup(grp.displayName, grp.mailNickname, grp.description, grp.isPrivate, userEmail);
        summary.groupsCreated++;
        log.info(`✓ Group "${grp.displayName}" (${grp.isPrivate ? 'private' : 'public'}) created`);
      } catch (err) {
        log.warn(`Group "${grp.displayName}" failed: ${err.message}`);
        summary.errors.push(`Group "${grp.displayName}": ${err.message}`);
      }
    }

    // ── 21b. Real Distribution List + members ────────────────────────────────
    // A genuine DL test: record a mail-enabled DL address on the SOURCE domain so §47 can send
    // THROUGH it. Preference order:
    //   1. env.DISTRIBUTION_LIST_ADDRESS — a DL PRE-CREATED in the Admin Center on the source
    //      user's domain (e.g. qaagentdL@qatestagent.com). This is preferred because Graph/our app
    //      CANNOT set a group's SMTP domain (403) — a Graph-created group always lands on the tenant
    //      default domain (e.g. filefuze.co), which is the wrong domain for the migrating user.
    //   2. Fallback: create a Graph group (tenant default domain) when no pre-created DL is set.
    const preCreatedDl = env.DISTRIBUTION_LIST_ADDRESS;
    if (preCreatedDl) {
      distributionListAddress = preCreatedDl;
      // Use a real tenant correspondent (not the source user) as the live sender so §47 can send
      // THROUGH the real DL; if fan-out doesn't reach the source inbox, §47 falls back to injecting
      // the email with this source-domain address in the To field (validates To/CC preservation).
      dlLiveSender = realMemberSenders.map((s) => s.address).find((a) => a !== userEmail) || null;
      log.info(`✓ Using pre-created source-domain Distribution List: ${distributionListAddress}` +
        (dlLiveSender ? ` (live sender: ${dlLiveSender})` : ' (no live sender — §47 will inject)'));
    } else if (realMemberSenders.length > 0) {
      const dlNick = `qa-dist-list-${ts}`;
      const domain = userEmail.split('@')[1] || 'qatestagent.com';
      try {
        const dlGroup = await outlookClient.createGroup(
          'QA Distribution List', dlNick, 'Mail-enabled distribution list for migration QA', false, userEmail
        );
        distributionListAddress = dlGroup.mail || `${dlNick}@${domain}`;
        summary.groupsCreated++;
        if (dlGroup.mail && userEmail.split('@')[1] && !dlGroup.mail.toLowerCase().endsWith('@' + userEmail.split('@')[1].toLowerCase())) {
          log.warn(`DL created on tenant-default domain (${dlGroup.mail}) — NOT the source domain. ` +
            `Set DISTRIBUTION_LIST_ADDRESS to a DL pre-created on ${userEmail.split('@')[1]} to fix.`);
        }

        // Members: source user (so live fan-out reaches their inbox) + up to 2 correspondents.
        const memberEmails = [userEmail, ...realMemberSenders.slice(0, 2).map((s) => s.address)]
          .filter((e, i, arr) => e && arr.indexOf(e) === i);
        const memberResult = await outlookClient.addGroupMembers(dlGroup.id, memberEmails, userEmail);
        // First correspondent member becomes the live sender in §47 (not the source user).
        dlLiveSender = realMemberSenders.map((s) => s.address).find((a) => a !== userEmail) || null;
        log.info(
          `✓ Distribution List "QA Distribution List" (${distributionListAddress}) created — ` +
          `members added: ${memberResult.added.join(', ') || 'none'}` +
          (memberResult.failed.length ? ` | failed: ${memberResult.failed.join(', ')}` : '')
        );
      } catch (err) {
        log.warn(`Distribution List group failed: ${err.message} — §47 will use fallback address`);
        distributionListAddress = null;
        summary.errors.push(`Distribution List group: ${err.message}`);
      }
    } else {
      log.info('No real tenant accounts configured — skipping real Distribution List (§47 uses fixed address)');
    }

    // ── 22. 15-level nested folder structure ────────────────────────────────
    // Each level gets 2 emails placed directly via createMessageInFolder(folderId)
    // which triggers the EWS+move path internally — no separate move call needed.
    log.info('E2E: creating 15-level nested folder structure…');
    try {
      const nestedFolderNames = Array.from({ length: 15 }, (_, i) =>
        `QA-Nested-Level-${String(i + 1).padStart(2, '0')}`
      );
      const nestedFolderIds = await outlookClient.createNestedFolderChain(userEmail, nestedFolderNames);
      log.info(`✓ Created ${nestedFolderIds.length} nested folders`);

      for (let lvl = 0; lvl < nestedFolderIds.length; lvl++) {
        if (context.executionId && executionService.isCancelled(context.executionId)) break;
        const folderId   = nestedFolderIds[lvl];
        const folderName = nestedFolderNames[lvl];
        const depth      = lvl + 1;
        const sender     = pick(lvl);   // rotate sender across levels

        // Received email at this depth
        try {
          await outlookClient.createMessageInFolder(userEmail, folderId, {
            subject:      `QA E2E 22 - Nested Level ${depth} Received Email`,
            body:         { contentType: 'text', content: `Email received at nesting depth ${depth} (${folderName}). Tests that migration preserves emails at any nesting depth.` },
            from:         { emailAddress: sender },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead:       depth % 2 === 0,
            isDraft:      false,
          });
          summary.messagesCreated++;
          log.info(`✓ Nested depth ${depth} received email → ${folderName}`);
        } catch (err) {
          log.warn(`Nested depth ${depth} received failed: ${err.message}`);
          summary.errors.push(`Nested depth ${depth} received: ${err.message}`);
        }

        // Sent email at this depth
        try {
          await outlookClient.createMessageInFolder(userEmail, folderId, {
            subject:      `QA E2E 22 - Nested Level ${depth} Sent Email`,
            body:         { contentType: 'text', content: `Sent email at nesting depth ${depth} (${folderName}). Tests sent items at deep nesting levels.` },
            from:         { emailAddress: selfAddr },
            toRecipients: [{ emailAddress: sender }],
            isRead:       true,
            isDraft:      false,
          });
          summary.messagesCreated++;
          log.info(`✓ Nested depth ${depth} sent email → ${folderName}`);
        } catch (err) {
          log.warn(`Nested depth ${depth} sent failed: ${err.message}`);
          summary.errors.push(`Nested depth ${depth} sent: ${err.message}`);
        }

        if (!summary.foldersPopulated.includes(folderName)) summary.foldersPopulated.push(folderName);
      }
    } catch (err) {
      log.warn(`15-level nested folder structure failed: ${err.message}`);
      summary.errors.push(`Nested folders: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 23. Sub-level folder structure ─────────────────────────────────────────
    // QA-SubLevel-Root  (root — 3 emails)
    //   └─ QA-Sub-Q1   (20 emails — comprehensive scenarios)
    //        ├─ QA-Sub-Q1-Sub1  (3 emails)
    //        └─ QA-Sub-Q1-Sub2  (3 emails)
    //   ├─ QA-Sub-Q2  (3 emails)
    //   ├─ QA-Sub-Q3  (3 emails)
    //   ├─ QA-Sub-Q4  (3 emails)
    //   └─ QA-Sub-Q5  (3 emails)
    // All emails are placed directly via createMessageInFolder(folderId) which
    // uses the EWS+move path — no separate move call needed.
    log.info('E2E: creating sub-level folder structure…');
    try {
      const rootId = await outlookClient.getOrCreateMailFolder(userEmail, 'QA-SubLevel-Root');

      // Helper: create one message directly in a custom folder (EWS+move path)
      const addMsg = async (folderId, msgBody) => {
        try {
          await outlookClient.createMessageInFolder(userEmail, folderId, msgBody);
          summary.messagesCreated++;
        } catch (e) {
          log.warn(`SubLevel msg "${msgBody.subject}": ${e.message}`);
          summary.errors.push(`SubLevel "${msgBody.subject}": ${e.message}`);
        }
      };

      // ── Root folder — 3 emails ──────────────────────────────────────────────
      await addMsg(rootId, { subject: 'QA E2E 23 - Root Folder Received Email', body: { contentType: 'text', content: 'Email in the root sub-level folder — tests root + child hierarchy migration.' }, from: { emailAddress: pick(0) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true, isDraft: false });
      await addMsg(rootId, { subject: 'QA E2E 23 - Root Folder Sent Email', body: { contentType: 'text', content: 'Sent email stored in the root sub-level folder.' }, from: { emailAddress: selfAddr }, toRecipients: [{ emailAddress: pick(1) }], isRead: true, isDraft: false });
      await addMsg(rootId, { subject: 'QA E2E 23 - Root Folder With Attachment', body: { contentType: 'text', content: 'Root folder email with PDF attachment — tests attachment + folder hierarchy.' }, from: { emailAddress: pick(2) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-root-report.pdf', contentType: 'application/pdf', contentBytes: QA_PDF_BYTES }] });
      if (!summary.foldersPopulated.includes('QA-SubLevel-Root')) summary.foldersPopulated.push('QA-SubLevel-Root');
      log.info('✓ QA-SubLevel-Root: 3 emails');

      // ── QA-Sub-Q1 — 20 diverse test scenarios ──────────────────────────────
      // Space out sibling sub-folder creation so each gets a distinct, increasing timestamp and the
      // destination preserves folder order (matches manual creation with natural gaps). Configurable
      // via FOLDER_CREATE_INTERVAL_MS (default 30s; 0 disables).
      const _folderGap = async () => { if (env.FOLDER_CREATE_INTERVAL_MS > 0) { log.info(`Waiting ${Math.round(env.FOLDER_CREATE_INTERVAL_MS / 1000)}s before next sub-folder (preserve order)…`); await new Promise((r) => setTimeout(r, env.FOLDER_CREATE_INTERVAL_MS)); } };
      const q1Id = await outlookClient.createChildFolder(userEmail, rootId, 'QA-Sub-Q1');
      await _folderGap();
      const q1Scenarios = [
        { subject: 'QA E2E 23 - Q1 Plain Text Unread',       body: { contentType: 'text', content: 'Unread plain text email in sub-folder Q1.' },                                                                                                                         from: { emailAddress: pick(0) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Plain Text Read',         body: { contentType: 'text', content: 'Read plain text email in sub-folder Q1.' },                                                                                                                           from: { emailAddress: pick(1) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false },
        { subject: 'QA E2E 23 - Q1 HTML Body Formatting',    body: { contentType: 'HTML', content: '<html><body><h2>Sub-Folder Q1 HTML Email</h2><p>This email has <strong>bold</strong>, <em>italic</em>, and <u>underlined</u> text.</p><ul><li>Point 1</li><li>Point 2</li></ul></body></html>' }, from: { emailAddress: pick(2) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false },
        { subject: 'QA E2E 23 - Q1 With PDF Attachment',     body: { contentType: 'text', content: 'Email with PDF attachment in sub-folder Q1.' },                                                                                                                       from: { emailAddress: pick(3) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-q1-report.pdf', contentType: 'application/pdf', contentBytes: QA_PDF_BYTES }] },
        { subject: 'QA E2E 23 - Q1 With TXT Attachment',     body: { contentType: 'text', content: 'Email with text attachment in sub-folder Q1.' },                                                                                                                      from: { emailAddress: pick(4) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-q1-notes.txt', contentType: 'text/plain', contentBytes: Buffer.from('QA sub-folder Q1 text attachment').toString('base64') }] },
        { subject: 'QA E2E 23 - Q1 With CC Recipient',       body: { contentType: 'text', content: 'Email with CC recipient in sub-folder Q1 — tests CC field preservation in sub-folder.' },                                                                            from: { emailAddress: pick(0) }, toRecipients: [{ emailAddress: { address: userEmail } }], ccRecipients: [{ emailAddress: { address: pick(2).address, name: pick(2).name } }], isRead: false, isDraft: false },
        { subject: 'QA E2E 23 - Q1 High Importance',         body: { contentType: 'text', content: 'High importance email in sub-folder Q1.' },                                                                                                                           from: { emailAddress: pick(1) }, toRecipients: [{ emailAddress: { address: userEmail } }], importance: 'high', isRead: false, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Low Importance',          body: { contentType: 'text', content: 'Low importance email in sub-folder Q1.' },                                                                                                                            from: { emailAddress: pick(2) }, toRecipients: [{ emailAddress: { address: userEmail } }], importance: 'low', isRead: true,  isDraft: false },
        { subject: 'QA E2E 23 - Q1 Flagged Email',           body: { contentType: 'text', content: 'Flagged (starred) email in sub-folder Q1 — tests flag preservation in sub-folder.' },                                                                               from: { emailAddress: pick(3) }, toRecipients: [{ emailAddress: { address: userEmail } }], flag: { flagStatus: 'flagged' }, isRead: false, isDraft: false },
        { subject: 'RE: QA E2E 23 - Q1 Reply Format',        body: { contentType: 'text', content: 'Reply email (RE: prefix) in sub-folder Q1 — tests reply subject migration.' },                                                                                       from: { emailAddress: pick(4) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false },
        { subject: 'FW: QA E2E 23 - Q1 Forwarded Format',   body: { contentType: 'HTML', content: '<html><body><p>Forwarded from Q1.</p><hr/><p><b>From:</b> ' + pick(0).name + '<br/><b>Subject:</b> Original Q1 Email</p><p>Original content here.</p></body></html>' }, from: { emailAddress: pick(0) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Long Subject Line That Tests Subject Truncation And Encoding In Sub-Folder Migration Scenario', body: { contentType: 'text', content: 'Email with long subject in Q1.' }, from: { emailAddress: pick(1) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Emoji Body 🎉✅📧',       body: { contentType: 'text', content: 'Emoji content: 😊 🚀 ✅ ❌ 📎 🗂️ 🔔 💡 🌍 🎉 — tests emoji preservation in sub-folder.' },                                                                          from: { emailAddress: pick(2) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Multi-Paragraph Body',    body: { contentType: 'text', content: 'Paragraph 1: Introduction to this sub-folder test email.\n\nParagraph 2: This email spans multiple paragraphs to test body content preservation.\n\nParagraph 3: Final paragraph for verification.' }, from: { emailAddress: pick(3) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Multiple TO Recipients',  body: { contentType: 'text', content: 'Email sent to multiple TO recipients in Q1.' },                                                                                                                       from: { emailAddress: pick(4) }, toRecipients: [{ emailAddress: { address: userEmail } }, { emailAddress: { address: pick(2).address, name: pick(2).name } }], isRead: true, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Sent By User',            body: { contentType: 'text', content: 'Email sent by the mailbox user, stored in Q1 — tests sent items in sub-folder.' },                                                                                   from: { emailAddress: selfAddr }, toRecipients: [{ emailAddress: pick(0) }], isRead: true, isDraft: false },
        { subject: 'QA E2E 23 - Q1 Sent With Attachment',    body: { contentType: 'text', content: 'Sent email with PDF attachment in Q1.' },                                                                                                                             from: { emailAddress: selfAddr }, toRecipients: [{ emailAddress: pick(1) }], isRead: true, isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-q1-sent-report.pdf', contentType: 'application/pdf', contentBytes: QA_PDF_BYTES }] },
        { subject: 'QA E2E 23 - Q1 Unread With Attachment',  body: { contentType: 'text', content: 'Unread email with attachment in Q1 — tests unread + attachment combo.' },                                                                                            from: { emailAddress: pick(0) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-q1-unread.txt', contentType: 'text/plain', contentBytes: Buffer.from('QA unread attachment in Q1').toString('base64') }] },
        { subject: 'QA E2E 23 - Q1 Starred Flagged',         body: { contentType: 'text', content: 'Starred (flagged) email in Q1 — should appear starred after migration.' },                                                                                           from: { emailAddress: pick(1) }, toRecipients: [{ emailAddress: { address: userEmail } }], flag: { flagStatus: 'flagged' }, importance: 'high', isRead: false, isDraft: false },
        { subject: 'QA E2E 23 - Q1 With Categories',         body: { contentType: 'text', content: 'Email with categories/tags in Q1 — tests label/category migration.' },                                                                                               from: { emailAddress: pick(2) }, toRecipients: [{ emailAddress: { address: userEmail } }], categories: ['QA-Migration', 'Test-Data'], isRead: true, isDraft: false },
      ];
      for (const m of q1Scenarios) await addMsg(q1Id, m);
      if (!summary.foldersPopulated.includes('QA-Sub-Q1')) summary.foldersPopulated.push('QA-Sub-Q1');
      log.info(`✓ QA-Sub-Q1: ${q1Scenarios.length} emails (comprehensive scenarios)`);

      // ── QA-Sub-Q1-Sub1 and QA-Sub-Q1-Sub2 — 3 emails each ─────────────────
      for (let ss = 0; ss < 2; ss++) {
        const subSubName = ss === 0 ? 'QA-Sub-Q1-Sub1' : 'QA-Sub-Q1-Sub2';
        const ssId = await outlookClient.createChildFolder(userEmail, q1Id, subSubName);
        await _folderGap();
        await addMsg(ssId, { subject: `QA E2E 23 - ${subSubName} Received Unread`, body: { contentType: 'text', content: `Unread received email in grandchild folder ${subSubName} — tests 2-level sub-folder migration.` },                                         from: { emailAddress: pick(ss) },     toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false });
        await addMsg(ssId, { subject: `QA E2E 23 - ${subSubName} Received Read`,   body: { contentType: 'HTML', content: `<html><body><p>Read HTML email in grandchild folder <strong>${subSubName}</strong>.</p></body></html>` },                                   from: { emailAddress: pick(ss + 1) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false });
        await addMsg(ssId, { subject: `QA E2E 23 - ${subSubName} With Attachment`, body: { contentType: 'text', content: `Email with PDF attachment in grandchild folder ${subSubName}.` }, from: { emailAddress: pick(ss + 2) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true, isDraft: false, attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: `qa-${subSubName.toLowerCase()}.pdf`, contentType: 'application/pdf', contentBytes: QA_PDF_BYTES }] });
        if (!summary.foldersPopulated.includes(subSubName)) summary.foldersPopulated.push(subSubName);
        log.info(`✓ ${subSubName}: 3 emails`);
      }

      // ── QA-Sub-Q2 through QA-Sub-Q10 — 3 emails each (10 total sub-folders under root) ──
      const q2to10 = ['QA-Sub-Q2', 'QA-Sub-Q3', 'QA-Sub-Q4', 'QA-Sub-Q5', 'QA-Sub-Q6', 'QA-Sub-Q7', 'QA-Sub-Q8', 'QA-Sub-Q9', 'QA-Sub-Q10'];
      for (let si = 0; si < q2to10.length; si++) {
        const sfName = q2to10[si];
        const sfId   = await outlookClient.createChildFolder(userEmail, rootId, sfName);
        await _folderGap();
        await addMsg(sfId, { subject: `QA E2E 23 - ${sfName} Received Unread`,    body: { contentType: 'text', content: `Unread received email in sub-folder ${sfName} — tests sibling sub-folder migration.` },                                                       from: { emailAddress: pick(si) },     toRecipients: [{ emailAddress: { address: userEmail } }], isRead: false, isDraft: false });
        await addMsg(sfId, { subject: `QA E2E 23 - ${sfName} Received Read HTML`, body: { contentType: 'HTML', content: `<html><body><p>Read HTML email in sub-folder <strong>${sfName}</strong>.</p><p>Tests HTML body in nested folder.</p></body></html>` },         from: { emailAddress: pick(si + 1) }, toRecipients: [{ emailAddress: { address: userEmail } }], isRead: true,  isDraft: false });
        await addMsg(sfId, { subject: `QA E2E 23 - ${sfName} Sent By User`,       body: { contentType: 'text', content: `Sent email stored in sub-folder ${sfName} — tests sent items in sibling sub-folder.` },                                                       from: { emailAddress: selfAddr },     toRecipients: [{ emailAddress: pick(si + 2) }],            isRead: true,  isDraft: false });
        if (!summary.foldersPopulated.includes(sfName)) summary.foldersPopulated.push(sfName);
        log.info(`✓ ${sfName}: 3 emails`);
      }
    } catch (err) {
      log.warn(`Sub-level folder structure failed: ${err.message}`);
      summary.errors.push(`Sub-level folders: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 24. Inbox forwarding rule tests (two cases) ─────────────────────────
    // Case A: rule routes a sender to a NEWLY CREATED folder (simulates "Create new folder"
    //         in Outlook's rule UI). Folder name includes the sender name.
    // Case B: rule routes a different sender to an ALREADY EXISTING custom folder
    //         (simulates "Move to a different folder…" → select existing folder).
    // Both rules use "From: <sender>" as the condition.
    // Requires MailboxSettings.ReadWrite application permission on the Azure AD app.

    // Pick last two senders from the rotation as dedicated rule-trigger senders
    // so they don't conflict with senders used in earlier sections.
    const fallback = FALLBACK_EXTERNAL_SENDERS;
    const ruleRotation = senderRotation.length >= 2 ? senderRotation : fallback;
    const ruleSenderA = toSenderObject(ruleRotation[ruleRotation.length - 1]);       // Ron (new folder)
    const ruleSenderB = toSenderObject(ruleRotation[ruleRotation.length >= 2 ? ruleRotation.length - 2 : 0]); // Dan (existing folder)
    const senderAName = (ruleSenderA.name || ruleSenderA.address.split('@')[0]).replace(/\s+/g, '-');
    const senderBName = (ruleSenderB.name || ruleSenderB.address.split('@')[0]).replace(/\s+/g, '-');

    // ── 24-A: new folder created specifically for the rule ───────────────────
    log.info(`E2E: creating forwarding rule 24-A — route ${senderAName} to new folder…`);
    try {
      const newFolderName = `QA-Forwarding-Rule-From-${senderAName}`;
      const newFolderId   = await outlookClient.getOrCreateMailFolder(userEmail, newFolderName);

      const ruleA = await outlookClient.createInboxRule(userEmail, {
        displayName:  `QA - Forwarding Rule: route ${senderAName} to new folder`,
        sequence:     100,
        isEnabled:    true,
        conditions:   { fromAddresses: [{ emailAddress: { address: ruleSenderA.address, name: ruleSenderA.name } }] },
        actions:      { moveToFolder: newFolderId, stopProcessingRules: true },
      });
      log.info(`✓ Rule 24-A created: "${ruleA.displayName}" → ${newFolderName}`);
      if (!summary.foldersPopulated.includes(newFolderName)) summary.foldersPopulated.push(newFolderName);

      // Deliver via the rule: send from the rule's sender so Exchange routes it to the new folder.
      const canSendRule = senderRotation.length >= 2; // ruleSenderA is a real account only then
      const fwdMsgsA = [
        { subject: `QA E2E 24A - ${senderAName} Routed Email 1`, body: `Email from ${senderAName} routed to new folder by Outlook inbox rule — migration QA.`,            isRead: true  },
        { subject: `QA E2E 24A - ${senderAName} Routed Email 2`, body: `Second email from ${senderAName} in new rule folder — tests multiple messages after rule routing.`, isRead: false },
        { subject: `QA E2E 24A - ${senderAName} Routed HTML`,    body: `<html><body><p>HTML email from ${senderAName} routed by rule — tests HTML in new rule folder.</p></body></html>`, isRead: false, html: true },
      ];
      for (const fm of fwdMsgsA) {
        try {
          const via = await this._deliverThroughRule(userEmail, {
            senderObj: ruleSenderA, targetFolderId: newFolderId,
            subject: fm.subject, body: fm.body, contentType: fm.html ? 'html' : 'text',
            isRead: fm.isRead, canSend: canSendRule, log,
          });
          summary.messagesCreated++;
          log.info(`✓ 24-A: "${fm.subject}" (${via === 'rule' ? 'routed by rule' : 'injected'})`);
        } catch (err) {
          log.warn(`24-A email "${fm.subject}" failed: ${err.message}`);
          summary.errors.push(`Rule 24-A "${fm.subject}": ${err.message}`);
        }
      }
      log.info(`✓ Rule 24-A complete — ${fwdMsgsA.length} emails in ${newFolderName}`);
    } catch (err) {
      log.warn(`Inbox rule 24-A failed: ${err.message}`);
      summary.errors.push(`Inbox rule 24-A: ${err.message}`);
    }

    // ── 24-B: rule routes to an already-existing custom folder ───────────────
    log.info(`E2E: creating forwarding rule 24-B — route ${senderBName} to existing folder…`);
    try {
      const existFolderName = `QA-Forwarding-Rule-From-${senderBName}`;
      const existFolderId   = await outlookClient.getOrCreateMailFolder(userEmail, existFolderName);

      // Pre-populate the folder with one email so it is "already existing" before the rule is created.
      try {
        await outlookClient.createMessageInFolder(userEmail, existFolderId, {
          subject:      `QA E2E 24B - ${senderBName} Pre-existing Email`,
          body:         { contentType: 'text', content: `Pre-existing email in ${existFolderName} before the forwarding rule was set up.` },
          from:         { emailAddress: ruleSenderB },
          toRecipients: [{ emailAddress: { address: userEmail, name: userEmail.split('@')[0] } }],
          isRead: true, isDraft: false,
        });
        summary.messagesCreated++;
        log.info(`✓ 24-B: pre-populated "${existFolderName}" with one existing email`);
      } catch (err) {
        log.warn(`24-B pre-populate failed: ${err.message}`);
      }

      const ruleB = await outlookClient.createInboxRule(userEmail, {
        displayName:  `QA - Forwarding Rule: route ${senderBName} to existing folder`,
        sequence:     101,
        isEnabled:    true,
        conditions:   { fromAddresses: [{ emailAddress: { address: ruleSenderB.address, name: ruleSenderB.name } }] },
        actions:      { moveToFolder: existFolderId, stopProcessingRules: true },
      });
      log.info(`✓ Rule 24-B created: "${ruleB.displayName}" → ${existFolderName}`);
      if (!summary.foldersPopulated.includes(existFolderName)) summary.foldersPopulated.push(existFolderName);

      const canSendRuleB = senderRotation.length >= 2; // ruleSenderB is a real account only then
      const fwdMsgsB = [
        { subject: `QA E2E 24B - ${senderBName} Routed Email 1`, body: `Email from ${senderBName} routed to existing folder by inbox rule — tests rule targeting existing folder.`,  isRead: true  },
        { subject: `QA E2E 24B - ${senderBName} Routed Email 2`, body: `Second email from ${senderBName} in existing folder — tests co-existence of pre-existing and rule-routed mail.`, isRead: false },
      ];
      for (const fm of fwdMsgsB) {
        try {
          const via = await this._deliverThroughRule(userEmail, {
            senderObj: ruleSenderB, targetFolderId: existFolderId,
            subject: fm.subject, body: fm.body, contentType: 'text',
            isRead: fm.isRead, canSend: canSendRuleB, log,
          });
          summary.messagesCreated++;
          log.info(`✓ 24-B: "${fm.subject}" (${via === 'rule' ? 'routed by rule' : 'injected'})`);
        } catch (err) {
          log.warn(`24-B email "${fm.subject}" failed: ${err.message}`);
          summary.errors.push(`Rule 24-B "${fm.subject}": ${err.message}`);
        }
      }
      log.info(`✓ Rule 24-B complete — ${fwdMsgsB.length} new + 1 pre-existing in ${existFolderName}`);
    } catch (err) {
      log.warn(`Inbox rule 24-B failed: ${err.message}`);
      summary.errors.push(`Inbox rule 24-B: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 25. Moved-to-folder scenario ────────────────────────────────────────
    // Creates emails directly in Inbox and Sent Items, then moves them into a
    // dedicated custom folder — QA-Moved-From-Inbox-Sent.
    // Tests that messages manually reorganised by the user before migration
    // (i.e. not originally created in a custom folder) still land in the correct
    // destination folder after migration.
    log.info('E2E: creating "moved-to-folder" scenario (Inbox + Sent → QA-Moved-From-Inbox-Sent)…');
    try {
      const movedFolderId = await outlookClient.getOrCreateMailFolder(userEmail, 'QA-Moved-From-Inbox-Sent');

      // 1. Create 2 messages in Inbox, then move them to the custom folder
      const inboxMoveMessages = [
        {
          subject: 'QA E2E 25 - Moved From Inbox Email 1',
          body: { contentType: 'text', content: 'Originally delivered to Inbox — moved to QA-Moved-From-Inbox-Sent before migration. Tests that manually reorganised inbox mail migrates to the correct folder.' },
          from: { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
        {
          subject: 'QA E2E 25 - Moved From Inbox Email 2',
          body: { contentType: 'html', content: '<html><body><p>Second inbox email moved to custom folder — <b>QA-Moved-From-Inbox-Sent</b>.</p></body></html>' },
          from: { emailAddress: toSenderObject(senderRotation.length > 1 ? senderRotation[1] : FALLBACK_EXTERNAL_SENDERS[1]) },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      ];

      for (const msgBody of inboxMoveMessages) {
        try {
          const created   = await outlookClient.createMessageInFolder(userEmail, 'inbox', msgBody);
          let createdId   = created?.id;
          if (!createdId && created?.internetMessageId) {
            createdId = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'inbox', created.internetMessageId);
          }
          if (createdId) {
            await outlookClient.moveMessageToFolder(userEmail, createdId, movedFolderId);
            log.info(`✓ Moved to QA-Moved-From-Inbox-Sent: "${msgBody.subject}"`);
          } else {
            log.warn(`Could not obtain message ID for "${msgBody.subject}" — move skipped`);
          }
          summary.messagesCreated++;
        } catch (err) {
          log.warn(`Moved-from-inbox "${msgBody.subject}" failed: ${err.message}`);
          summary.errors.push(`Moved from inbox "${msgBody.subject}": ${err.message}`);
        }
      }

      // 2. Create 2 messages in Sent Items, then move them to the custom folder
      const sentMoveMessages = [
        {
          subject: 'QA E2E 25 - Moved From Sent Email 1',
          body: { contentType: 'text', content: 'Originally in Sent Items — moved to QA-Moved-From-Inbox-Sent before migration. Tests that reorganised sent mail migrates to the correct folder.' },
          from: { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
        {
          subject: 'QA E2E 25 - Moved From Sent Email 2',
          body: { contentType: 'text', content: 'Second sent email moved to custom folder — QA-Moved-From-Inbox-Sent.' },
          from: { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: toSenderObject(senderRotation.length > 1 ? senderRotation[1] : FALLBACK_EXTERNAL_SENDERS[1]) }],
          isRead: true, isDraft: false,
        },
      ];

      for (const msgBody of sentMoveMessages) {
        try {
          const created   = await outlookClient.createMessageInFolder(userEmail, 'sentitems', msgBody);
          let createdId   = created?.id;
          if (!createdId && created?.internetMessageId) {
            createdId = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'sentitems', created.internetMessageId);
          }
          if (createdId) {
            await outlookClient.moveMessageToFolder(userEmail, createdId, movedFolderId);
            log.info(`✓ Moved to QA-Moved-From-Inbox-Sent: "${msgBody.subject}"`);
          } else {
            log.warn(`Could not obtain message ID for "${msgBody.subject}" — move skipped`);
          }
          summary.messagesCreated++;
        } catch (err) {
          log.warn(`Moved-from-sent "${msgBody.subject}" failed: ${err.message}`);
          summary.errors.push(`Moved from sent "${msgBody.subject}": ${err.message}`);
        }
      }

      if (!summary.foldersPopulated.includes('QA-Moved-From-Inbox-Sent')) {
        summary.foldersPopulated.push('QA-Moved-From-Inbox-Sent');
      }
      log.info('✓ Moved-to-folder scenario complete (4 messages in QA-Moved-From-Inbox-Sent)');
    } catch (err) {
      log.warn(`Moved-to-folder scenario failed: ${err.message}`);
      summary.errors.push(`Moved-to-folder: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 26. Historical / old-dated email ────────────────────────────────────
    log.info('E2E: creating historical/old-dated email scenario…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:          'QA E2E 26 - Historical Inbox Email (2019)',
        body:             { contentType: 'text', content: 'Email with old sentDateTime (2019-03-15) — tests timestamp preservation during migration.' },
        from:             { emailAddress: externalSender },
        toRecipients:     [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        sentDateTime:     '2019-03-15T09:00:00Z',
        receivedDateTime: '2019-03-15T09:00:00Z',
      });
      summary.messagesCreated++;
      log.info('✓ Historical inbox email (2019) created');
    } catch (err) {
      log.warn(`Historical inbox email failed: ${err.message}`);
      summary.errors.push(`Historical inbox email: ${err.message}`);
    }
    try {
      await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject:          'QA E2E 26 - Historical Sent Email (2019)',
        body:             { contentType: 'text', content: 'Sent email with old sentDateTime (2019-03-15) — tests sent timestamp preservation.' },
        from:             { emailAddress: selfAddr },
        toRecipients:     [{ emailAddress: externalSender }],
        isRead: true, isDraft: false,
        sentDateTime:     '2019-03-15T09:00:00Z',
        receivedDateTime: '2019-03-15T09:00:00Z',
      });
      summary.messagesCreated++;
      log.info('✓ Historical sent email (2019) created');
    } catch (err) {
      log.warn(`Historical sent email failed: ${err.message}`);
      summary.errors.push(`Historical sent email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 27. Sensitivity-labeled emails ──────────────────────────────────────
    log.info('E2E: creating sensitivity-labeled emails…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 27 - Confidential Sensitivity Email',
        body:         { contentType: 'text', content: 'Email marked as Confidential — tests Outlook sensitivity label migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        sensitivity: 'confidential',
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Confidential sensitivity email created');
    } catch (err) {
      log.warn(`Confidential sensitivity email failed: ${err.message}`);
      summary.errors.push(`Confidential sensitivity email: ${err.message}`);
    }
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 27 - Private Sensitivity Email',
        body:         { contentType: 'text', content: 'Email marked as Private — tests Outlook private sensitivity migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        sensitivity: 'private',
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Private sensitivity email created');
    } catch (err) {
      log.warn(`Private sensitivity email failed: ${err.message}`);
      summary.errors.push(`Private sensitivity email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 28. Reply-To header ──────────────────────────────────────────────────
    log.info('E2E: creating reply-to header email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 28 - Reply-To Header Email',
        body:         { contentType: 'text', content: 'Email with replyTo address different from sender — tests Reply-To header preservation.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        replyTo: [{ emailAddress: { address: 'replyto-qa@external-replytest.com', name: 'QA ReplyTo Address' } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Reply-To header email created');
    } catch (err) {
      log.warn(`Reply-To header email failed: ${err.message}`);
      summary.errors.push(`Reply-To header email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 29. Empty subject email ──────────────────────────────────────────────
    log.info('E2E: creating empty-subject email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      '',
        body:         { contentType: 'text', content: 'Email with empty subject line — tests null/empty subject handling in migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Empty subject email created');
    } catch (err) {
      log.warn(`Empty subject email failed: ${err.message}`);
      summary.errors.push(`Empty subject email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 30. Completed flag (third flag state) ───────────────────────────────
    log.info('E2E: creating completed-flag email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 30 - Completed Flag Email',
        body:         { contentType: 'text', content: 'Email with completed flag state — tests Outlook three-state flag (notFlagged / flagged / complete) migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        flag:         { flagStatus: 'complete' },
        isRead: true, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Completed flag email created');
    } catch (err) {
      log.warn(`Completed flag email failed: ${err.message}`);
      summary.errors.push(`Completed flag email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 31. Sent email moved to custom folder ────────────────────────────────
    log.info('E2E: creating sent-email-moved-to-custom-folder scenario…');
    try {
      const sentCustomFolderId = await outlookClient.getOrCreateMailFolder(userEmail, 'QA-Sent-To-Custom');
      const sentCustomMessages = [
        {
          subject:      'QA E2E 31 - Sent Email Moved To Custom Folder 1',
          body:         { contentType: 'text', content: 'Sent email reorganised into a custom folder — tests sent items in custom folders.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
        {
          subject:      'QA E2E 31 - Sent Email Moved To Custom Folder 2',
          body:         { contentType: 'text', content: 'Second sent email reorganised into custom folder — tests bulk sent re-categorisation.' },
          from:         { emailAddress: selfAddr },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        },
      ];
      for (const msgBody of sentCustomMessages) {
        try {
          const created   = await outlookClient.createMessageInFolder(userEmail, 'sentitems', msgBody);
          let createdId   = created?.id;
          if (!createdId && created?.internetMessageId) {
            createdId = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'sentitems', created.internetMessageId);
          }
          if (createdId) {
            await outlookClient.moveMessageToFolder(userEmail, createdId, sentCustomFolderId);
            log.info(`✓ Moved to QA-Sent-To-Custom: "${msgBody.subject}"`);
          } else {
            log.warn(`Could not obtain message ID for "${msgBody.subject}" — move skipped`);
          }
          summary.messagesCreated++;
        } catch (err) {
          log.warn(`Sent-to-custom "${msgBody.subject}" failed: ${err.message}`);
          summary.errors.push(`Sent-to-custom "${msgBody.subject}": ${err.message}`);
        }
      }
      if (!summary.foldersPopulated.includes('QA-Sent-To-Custom')) {
        summary.foldersPopulated.push('QA-Sent-To-Custom');
      }
      log.info('✓ Sent-email-moved-to-custom-folder scenario complete');
    } catch (err) {
      log.warn(`Sent-to-custom-folder scenario failed: ${err.message}`);
      summary.errors.push(`Sent-to-custom-folder: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 32. Parent custom folder with emails at both parent and child level ──
    log.info('E2E: creating parent+child folder with emails at both levels…');
    try {
      const parentFolderId = await outlookClient.getOrCreateMailFolder(userEmail, 'QA-Parent-With-Sub');
      const parentMessages = [
        {
          subject:      'QA E2E 32 - Parent Folder Direct Email 1',
          body:         { contentType: 'text', content: 'Email in parent folder that also has child folders — tests parent-level email preservation.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
        {
          subject:      'QA E2E 32 - Parent Folder Direct Email 2',
          body:         { contentType: 'text', content: 'Second email in parent folder with children — tests folder co-existence.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      ];
      for (const msgBody of parentMessages) {
        try {
          const created   = await outlookClient.createMessageInFolder(userEmail, 'inbox', msgBody);
          let createdId   = created?.id;
          if (!createdId && created?.internetMessageId) {
            createdId = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'inbox', created.internetMessageId);
          }
          if (createdId) {
            await outlookClient.moveMessageToFolder(userEmail, createdId, parentFolderId);
            log.info(`✓ Moved to QA-Parent-With-Sub: "${msgBody.subject}"`);
          } else {
            log.warn(`Could not obtain message ID for "${msgBody.subject}" — move skipped`);
          }
          summary.messagesCreated++;
        } catch (err) {
          log.warn(`Parent folder email "${msgBody.subject}" failed: ${err.message}`);
          summary.errors.push(`Parent folder email "${msgBody.subject}": ${err.message}`);
        }
      }
      if (!summary.foldersPopulated.includes('QA-Parent-With-Sub')) {
        summary.foldersPopulated.push('QA-Parent-With-Sub');
      }

      const childFolderId = await outlookClient.createChildFolder(userEmail, parentFolderId, 'QA-Child-Under-Parent');
      const childMessages = [
        {
          subject:      'QA E2E 32 - Child Folder Email 1',
          body:         { contentType: 'text', content: 'Email in child subfolder of QA-Parent-With-Sub — tests children email migration.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        },
        {
          subject:      'QA E2E 32 - Child Folder Email 2',
          body:         { contentType: 'text', content: 'Second email in child subfolder — tests child-folder email count.' },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        },
      ];
      for (const msgBody of childMessages) {
        try {
          const created   = await outlookClient.createMessageInFolder(userEmail, 'inbox', msgBody);
          let createdId   = created?.id;
          if (!createdId && created?.internetMessageId) {
            createdId = await outlookClient.getGraphIdByInternetMessageId(userEmail, 'inbox', created.internetMessageId);
          }
          if (createdId) {
            await outlookClient.moveMessageToFolder(userEmail, createdId, childFolderId);
            log.info(`✓ Moved to QA-Child-Under-Parent: "${msgBody.subject}"`);
          } else {
            log.warn(`Could not obtain message ID for "${msgBody.subject}" — move skipped`);
          }
          summary.messagesCreated++;
        } catch (err) {
          log.warn(`Child folder email "${msgBody.subject}" failed: ${err.message}`);
          summary.errors.push(`Child folder email "${msgBody.subject}": ${err.message}`);
        }
      }
      if (!summary.foldersPopulated.includes('QA-Child-Under-Parent')) {
        summary.foldersPopulated.push('QA-Child-Under-Parent');
      }
      log.info('✓ Parent+child folder scenario complete');
    } catch (err) {
      log.warn(`Parent+child folder scenario failed: ${err.message}`);
      summary.errors.push(`Parent+child folder: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 33. Very large body email (~50 KB) ───────────────────────────────────
    log.info('E2E: creating large body email (~50 KB)…');
    try {
      const largeBody = 'Migration QA large body test. ' +
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. '.repeat(400);
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 33 - Large Body Email (~50KB)',
        body:         { contentType: 'text', content: largeBody },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Large body email (~50 KB) created');
    } catch (err) {
      log.warn(`Large body email failed: ${err.message}`);
      summary.errors.push(`Large body email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 34. Many TO recipients (10+) ─────────────────────────────────────────
    log.info('E2E: creating many-TO-recipients email…');
    try {
      const manyToRecipients = [{ emailAddress: { address: userEmail } }];
      for (let n = 1; n <= 10; n++) {
        manyToRecipients.push({ emailAddress: { address: `qa-to-${n}@bulk-recipients.test`, name: `QA Bulk Recipient ${n}` } });
      }
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 34 - Many TO Recipients (10+)',
        body:         { contentType: 'text', content: 'Email addressed to 10+ recipients — tests bulk TO field migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: manyToRecipients,
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Many TO recipients email created');
    } catch (err) {
      log.warn(`Many TO recipients email failed: ${err.message}`);
      summary.errors.push(`Many TO recipients email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 35. Mixed-language body ───────────────────────────────────────────────
    log.info('E2E: creating mixed-language body email…');
    try {
      const mixedLangBody = 'Migration QA multi-language test.\nEnglish: The quick brown fox.\nCyrillic: Быстрая коричневая лиса.\nChinese: 快速的棕色狐狸。\nJapanese: 素早い茶色のキツネ。\nArabic: الثعلب البني السريع.\nHebrew: השועל החום המהיר.\nEnd of multi-language content.';
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 35 - Mixed Language Body',
        body:         { contentType: 'text', content: mixedLangBody },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Mixed-language body email created');
    } catch (err) {
      log.warn(`Mixed-language body email failed: ${err.message}`);
      summary.errors.push(`Mixed-language body email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 36. Draft with no recipients ─────────────────────────────────────────
    log.info('E2E: creating draft with no recipients…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'drafts', {
        subject:      'QA E2E 36 - Draft With No Recipients',
        body:         { contentType: 'text', content: 'Draft email with empty toRecipients — tests incomplete draft migration.' },
        from:         { emailAddress: { address: userEmail } },
        toRecipients: [],
        isRead: false, isDraft: true,
      });
      summary.messagesCreated++;
      log.info('✓ Draft with no recipients created');
    } catch (err) {
      log.warn(`Draft with no recipients failed: ${err.message}`);
      summary.errors.push(`Draft with no recipients: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 37. ICS attachment email (meeting invite as mail) ────────────────────
    log.info('E2E: creating ICS attachment email…');
    try {
      const icsContent = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//QA Migration Test//EN\r\nBEGIN:VEVENT\r\nUID:qa-migration-ics-test@migrationqa\r\nSUMMARY:QA Migration Test Meeting\r\nDTSTART:20260601T100000Z\r\nDTEND:20260601T110000Z\r\nDESCRIPTION:ICS attachment migration QA test.\r\nEND:VEVENT\r\nEND:VCALENDAR';
      const icsBase64 = Buffer.from(icsContent).toString('base64');
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E 37 - ICS Attachment Email (Meeting Invite)',
        body:         { contentType: 'text', content: 'Email with .ics calendar attachment — tests ICS attachment type migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-meeting-invite.ics',
          contentType: 'text/calendar',
          contentBytes: icsBase64,
        }],
      });
      summary.messagesCreated++;
      log.info('✓ ICS attachment email created');
    } catch (err) {
      log.warn(`ICS attachment email failed: ${err.message}`);
      summary.errors.push(`ICS attachment email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 38. Attachment emails per folder — medium (512KB), each with a different file type ──
    log.info('E2E: creating per-folder attachment emails (varied file types)…');

    // Build realistic ~512KB content per file type (correct magic bytes where possible)
    const _pdfHeader  = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n9\n%%EOF\n';
    const _jpgHeader  = Buffer.from([0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01]);
    const _pngHeader  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
    const _zipHeader  = Buffer.from([0x50,0x4B,0x03,0x04]); // XLSX/DOCX are ZIP containers
    const _pad        = (hdr, totalBytes) => {
      const h = Buffer.isBuffer(hdr) ? hdr : Buffer.from(hdr);
      return Buffer.concat([h, Buffer.alloc(Math.max(0, totalBytes - h.length), 0x41)]).toString('base64');
    };
    // Valid, content-bearing attachment at a target size (opens with real content, not a blank/padded blob).
    const _genB64 = (name, mb = 0.5) => require('../../utils/testFileGenerator').generateTestFileBuffer(name, mb).toString('base64');

    // Inbox — PDF (most common received attachment)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject: 'QA E2E 38 - Inbox Medium Attachment (512KB PDF)',
        body: { contentType: 'text', content: 'Email with 512KB PDF report in Inbox — medium size attachment migration test.' },
        from: { emailAddress: pick(0) },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-report.pdf', contentType: 'application/pdf', contentBytes: _genB64('qa-medium-report.pdf') }],
      });
      summary.messagesCreated++;
      log.info('✓ Inbox medium attachment email created (PDF)');
    } catch (err) { log.warn(`Inbox medium attachment: ${err.message}`); summary.errors.push(`Inbox medium attachment: ${err.message}`); }

    // Archive — small TXT (1KB) + medium XLSX (512KB)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'archive', {
        subject: 'QA E2E 38 - Archive Small Attachment (1KB TXT)',
        body: { contentType: 'text', content: 'Email with small 1KB text file in Archive — tests small attachment in Archive folder.' },
        from: { emailAddress: pick(1) },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-archive-notes.txt', contentType: 'text/plain', contentBytes: Buffer.from('QA Archive notes — migration test file.\n\nThis text attachment tests 1KB file migration in the Archive folder.').toString('base64') }],
      });
      summary.messagesCreated++;
      if (!summary.foldersPopulated.includes('Archive')) summary.foldersPopulated.push('Archive');
      log.info('✓ Archive small attachment email created (TXT)');
    } catch (err) { log.warn(`Archive small attachment: ${err.message}`); summary.errors.push(`Archive small attachment: ${err.message}`); }

    try {
      await outlookClient.createMessageInFolder(userEmail, 'archive', {
        subject: 'QA E2E 38 - Archive Medium Attachment (512KB XLSX)',
        body: { contentType: 'text', content: 'Email with 512KB Excel spreadsheet in Archive — medium size test.' },
        from: { emailAddress: pick(2) },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-data.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: _genB64('qa-medium-data.xlsx') }],
      });
      summary.messagesCreated++;
      log.info('✓ Archive medium attachment email created (XLSX)');
    } catch (err) { log.warn(`Archive medium attachment: ${err.message}`); summary.errors.push(`Archive medium attachment: ${err.message}`); }

    // Sent Items — DOCX (Word document — typical sent attachment)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject: 'QA E2E 38 - Sent Items Medium Attachment (512KB DOCX)',
        body: { contentType: 'text', content: 'Sent email with 512KB Word document — medium size test for Sent Items.' },
        from: { emailAddress: selfAddr },
        toRecipients: [{ emailAddress: pick(0) }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-proposal.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: _genB64('qa-medium-proposal.docx') }],
      });
      summary.messagesCreated++;
      log.info('✓ Sent Items medium attachment email created (DOCX)');
    } catch (err) { log.warn(`Sent medium attachment: ${err.message}`); summary.errors.push(`Sent medium attachment: ${err.message}`); }

    // Drafts — MD (markdown — typical draft document)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'drafts', {
        subject: 'QA E2E 38 - Drafts Medium Attachment (512KB MD)',
        body: { contentType: 'text', content: 'Draft with 512KB Markdown file — medium size test for Drafts.' },
        from: { emailAddress: selfAddr },
        toRecipients: [{ emailAddress: pick(1) }],
        isRead: false, isDraft: true,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-draft-notes.md', contentType: 'text/markdown', contentBytes: _pad('# QA Draft Document\n\nThis is a draft Markdown attachment for migration testing.\n\n## Sections\n\n- Section 1\n- Section 2\n', 512 * 1024) }],
      });
      summary.messagesCreated++;
      log.info('✓ Drafts medium attachment email created (MD)');
    } catch (err) { log.warn(`Drafts medium attachment: ${err.message}`); summary.errors.push(`Drafts medium attachment: ${err.message}`); }

    // Junk Email — JPG (image spam is typical)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'junkemail', {
        subject: 'QA E2E 38 - Junk Email Medium Attachment (512KB JPG)',
        body: { contentType: 'text', content: 'Spam email with 512KB JPEG image — medium size test for Junk/Spam folder.' },
        from: { emailAddress: pick(3) },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-promo.jpg', contentType: 'image/jpeg', contentBytes: _genB64('qa-medium-promo.jpg') }],
      });
      summary.messagesCreated++;
      log.info('✓ Junk Email medium attachment email created (JPG)');
    } catch (err) { log.warn(`Junk medium attachment: ${err.message}`); summary.errors.push(`Junk medium attachment: ${err.message}`); }

    // Deleted Items — PNG (screenshot/image attachment)
    try {
      await outlookClient.createMessageInFolder(userEmail, 'deleteditems', {
        subject: 'QA E2E 38 - Deleted Items Medium Attachment (512KB PNG)',
        body: { contentType: 'text', content: 'Deleted email with 512KB PNG image — medium size test for Trash.' },
        from: { emailAddress: pick(4) },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: true, isDraft: false,
        attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-medium-screenshot.png', contentType: 'image/png', contentBytes: _genB64('qa-medium-screenshot.png') }],
      });
      summary.messagesCreated++;
      log.info('✓ Deleted Items medium attachment email created (PNG)');
    } catch (err) { log.warn(`Deleted medium attachment: ${err.message}`); summary.errors.push(`Deleted medium attachment: ${err.message}`); }

    // Multi-type attachments — Custom folders (QA-Migration-Folder, QA-Work-Projects, QA-Client-Emails)
    // Each custom folder gets ONE email with 6 different file types attached in a single message.
    // Tests that migration tools preserve all attachment types and counts in custom/label folders.
    {
      // Minimal valid content for each file type (small but structurally plausible)
      const b64 = (s) => Buffer.from(s).toString('base64');

      // Minimal 1×1 white PNG (valid binary image)
      const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

      const makeAttachments = (folderLabel) => {
        // Build a real XLSX workbook so the file opens correctly in Excel
        const wb = XLSX_LIB.utils.book_new();
        const ws = XLSX_LIB.utils.aoa_to_sheet([
          ['ID', 'Name', 'Folder', 'Status'],
          [1, 'QA Test Row 1', folderLabel, 'Migrated'],
          [2, 'QA Test Row 2', folderLabel, 'Verified'],
          [3, 'QA Test Row 3', folderLabel, 'Pass'],
        ]);
        XLSX_LIB.utils.book_append_sheet(wb, ws, 'QA Data');
        const xlsxB64 = XLSX_LIB.write(wb, { type: 'base64', bookType: 'xlsx' });

        return [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-report-${folderLabel}.pdf`,
            contentType: 'application/pdf',
            contentBytes: MINIMAL_PDF_B64,
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-spreadsheet-${folderLabel}.xlsx`,
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            contentBytes: xlsxB64,
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-document-${folderLabel}.docx`,
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            contentBytes: MINIMAL_DOCX_B64,
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-image-${folderLabel}.png`,
            contentType: 'image/png',
            contentBytes: PNG_1X1,
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-data-${folderLabel}.csv`,
            contentType: 'text/csv',
            contentBytes: b64(`id,name,folder,status\n1,QA Test,${folderLabel},migrated\n2,Sample,${folderLabel},verified\n3,Check,${folderLabel},pass`),
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: `qa-notes-${folderLabel}.txt`,
            contentType: 'text/plain',
            contentBytes: b64(`QA migration notes for ${folderLabel}\n\nAttachment type: plain text\nTest: multi-type attachment in single email\nFolder: ${folderLabel}\nFiles: PDF, XLSX, DOCX, PNG, CSV, TXT`),
          },
        ];
      };

      const customFolderCacheSec38 = {};
      const _sec38Folders = [
        ['QA-Migration-Folder', 'QA-Migration-Folder'],
        ['QA-Work-Projects',    'QA-Work-Projects'],
        ['QA-Client-Emails',    'QA-Client-Emails'],
      ];
      for (let _fi = 0; _fi < _sec38Folders.length; _fi++) {
        const [folderName, folderDisplay] = _sec38Folders[_fi];
        try {
          let cfId = customFolderCacheSec38[folderName];
          if (!cfId) {
            cfId = await outlookClient.getOrCreateMailFolder(userEmail, folderName);
            customFolderCacheSec38[folderName] = cfId;
          }
          const folderLabel = folderName.toLowerCase().replace(/qa-/g, '').replace(/-/g, '_');
          await outlookClient.createMessageInFolder(userEmail, cfId, {
            subject: `QA E2E 38 - ${folderName} Multi-Type Attachments (PDF+XLSX+DOCX+PNG+CSV+TXT)`,
            body: {
              contentType: 'HTML',
              content: `<html><body><p>Email with <strong>6 different attachment types</strong> in custom folder <em>${folderName}</em>.</p>`
                + `<p>Attachments: PDF report, Excel spreadsheet, Word document, PNG image, CSV data, TXT notes.</p>`
                + `<p>Tests that migration preserves all file types and attachment count in custom folders/labels.</p></body></html>`,
            },
            from: { emailAddress: pick(_fi) },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            attachments: makeAttachments(folderLabel),
          });
          summary.messagesCreated++;
          if (!summary.foldersPopulated.includes(folderDisplay)) summary.foldersPopulated.push(folderDisplay);
          log.info(`✓ ${folderName} multi-type attachment email created (PDF, XLSX, DOCX, PNG, CSV, TXT)`);
        } catch (err) {
          log.warn(`${folderName} multi-type attachment: ${err.message}`);
          summary.errors.push(`${folderName} multi-type attachment: ${err.message}`);
        }
      }
    }

    // ── Section 39 — Rich Body + Multi-Size Attachments (Inbox & Sent Items) ─
    // Two emails: one received (Inbox), one sent (Sent Items). Each has a full
    // HTML rich body (formatting, emojis, inline sticker, table, code block) and
    // 5 attachments spanning ~1 KB → ~300 KB across .txt, .pdf, .png, .docx, .xlsx.
    {
      const b64sec39 = (s) => Buffer.from(s).toString('base64');
      const makeBytes = (n) => Buffer.alloc(n).toString('base64');

      // 48×48 solid golden-yellow PNG — visible inline sticker
      const STICKER_PNG = makeSolidColorPng(0xFF, 0xCC, 0x00, 48);
      const STICKER_CID = 'qa-sticker-39@cloudfuze.qa';

      const stickerAttachment = {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'sticker.png',
        contentType: 'image/png',
        contentBytes: STICKER_PNG,
        isInline: true,
        contentId: STICKER_CID,
      };

      const richAttachments = [
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-small-notes.txt',
          contentType: 'text/plain',
          contentBytes: b64sec39(
            'QA Rich Body Test — Plain Text Attachment (~1 KB)\n\n' +
            'Migration test: verify small plain-text attachment is preserved.\n\n' +
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor. '.repeat(8),
          ),
        },
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-medium-report.pdf',
          contentType: 'application/pdf',
          contentBytes: b64sec39(
            '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
            '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
            '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
            'xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n9\n%%EOF\n' +
            'QA migration test — rich body PDF ~15KB\n' +
            'A'.repeat(14000),
          ),
        },
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-screenshot.png',
          contentType: 'image/png',
          contentBytes: makeSolidColorPng(0x00, 0x96, 0xFF, 200), // valid 200×200 blue PNG
        },
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-large-document.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          contentBytes: makeBytes(150000),  // ~200 KB
        },
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-large-spreadsheet.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          contentBytes: makeBytes(225000),  // ~300 KB
        },
      ];

      const richHtml = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
<h2 style="color:#1a56db;">QA Rich Body Test — Formatting, Emojis &amp; Attachments 🎉</h2>
<p>This email tests <strong>bold text</strong>, <em>italic text</em>, <u>underlined text</u>, and <s>strikethrough text</s>.</p>
<p>Colored text: <span style="color:#c0392b;">Red warning</span>, <span style="color:#27ae60;">Green success</span>, <span style="color:#2980b9;">Blue info</span>, <span style="color:#8e44ad;">Purple note</span>.</p>
<p>Emojis inline: 😊 😂 🚀 ✅ ❌ 📎 🗂️ 🔔 💡 🌍 🎉 🔥 👍 ❤️ 🧪</p>
<p>Mixed languages: Hello | Hola | Bonjour | Hallo | こんにちは | 你好 | مرحبا | Привет</p>
<hr/>
<h3>Bullet List</h3>
<ul>
  <li>Migration source: Outlook (Exchange / Microsoft 365)</li>
  <li>Migration destination: Gmail / Google Workspace</li>
  <li>Attachments: 5 files across different sizes and types + 1 inline sticker</li>
  <li>Body: rich HTML with formatting, emojis, inline sticker, table, code block</li>
</ul>
<h3>Numbered List</h3>
<ol>
  <li>Verify message subject and sender are preserved ✅</li>
  <li>Verify all 5 attachments migrated with correct names and sizes ✅</li>
  <li>Verify HTML body formatting is retained ✅</li>
  <li>Verify inline sticker/image is preserved 🖼️</li>
  <li>Verify emoji characters render correctly 😊</li>
</ol>
<h3>Attachment Summary Table</h3>
<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:600px;">
  <thead style="background:#f0f4f8;"><tr><th>File</th><th>Type</th><th>Approx Size</th><th>Test Purpose</th></tr></thead>
  <tbody>
    <tr><td>qa-small-notes.txt</td><td>Plain Text</td><td>~1 KB</td><td>Small text attachment</td></tr>
    <tr><td>qa-medium-report.pdf</td><td>PDF</td><td>~15 KB</td><td>Medium PDF document</td></tr>
    <tr><td>qa-screenshot.png</td><td>PNG Image</td><td>~60 KB</td><td>Image attachment</td></tr>
    <tr><td>qa-large-document.docx</td><td>Word Document</td><td>~200 KB</td><td>Large Word doc</td></tr>
    <tr><td>qa-large-spreadsheet.xlsx</td><td>Excel Sheet</td><td>~300 KB</td><td>Large spreadsheet</td></tr>
  </tbody>
</table>
<h3>Blockquote</h3>
<blockquote style="border-left:4px solid #ccc;margin:8px 0;padding:8px 16px;color:#555;background:#f9f9f9;">
  &ldquo;Migration quality is not an accident; it is always the result of high intention, sincere effort, intelligent direction and skillful execution.&rdquo; &mdash; QA Team
</blockquote>
<h3>Code / Monospace Block</h3>
<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:monospace;font-size:13px;">
const result = await migrateEmail({
  source: 'outlook',
  destination: 'gmail',
  preserveFormatting: true,
  preserveAttachments: true,
});
console.log('Migration status:', result.status); // ✅ completed
</pre>
<p>Hyperlink: <a href="https://cloudfuze.com" target="_blank">CloudFuze Migration Platform</a></p>
<hr/>
<p>Inline sticker below 👇</p>
<img src="cid:${STICKER_CID}" alt="QA sticker" style="width:48px;height:48px;" />
<p style="font-size:12px;color:#888;margin-top:20px;">
  QA test email generated by OutlookTestDataAgent. Do not reply.<br/>
  Timestamp: ${new Date().toISOString()}
</p>
</body></html>`;

      // ── Inbox (received from external sender) ────────────────────────────────
      try {
        await outlookClient.createMessageInFolder(userEmail, 'inbox', {
          subject: 'QA E2E 39 - Rich Body Multi-Attachment (Inbox)',
          body: { contentType: 'HTML', content: richHtml },
          from: { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
          attachments: [stickerAttachment, ...richAttachments],
        });
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes('Inbox')) summary.foldersPopulated.push('Inbox');
        log.info('✓ Section 39 rich body email created in Inbox (inline sticker + 5 attachments: 1KB→300KB)');
      } catch (err) {
        log.warn(`Section 39 Inbox: ${err.message}`);
        summary.errors.push(`Section 39 Inbox: ${err.message}`);
      }

      // ── Sent Items (sent from user to external) ──────────────────────────────
      try {
        await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
          subject: 'QA E2E 39 - Rich Body Multi-Attachment (Sent)',
          body: { contentType: 'HTML', content: richHtml },
          from: { emailAddress: { address: userEmail } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
          attachments: [stickerAttachment, ...richAttachments],
        });
        summary.messagesCreated++;
        if (!summary.foldersPopulated.includes('Sent Items')) summary.foldersPopulated.push('Sent Items');
        log.info('✓ Section 39 rich body email created in Sent Items (inline sticker + 5 attachments: 1KB→300KB)');
      } catch (err) {
        log.warn(`Section 39 Sent: ${err.message}`);
        summary.errors.push(`Section 39 Sent: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 41. Account-level email forwarding ──────────────────────────────────
    // Replicates Outlook Settings → Mail → Forwarding:
    //   "Enable forwarding" + "Keep a copy of forwarded messages"
    // Implemented as an inbox rule with forwardTo action and no conditions
    // (= applies to all incoming messages). The "keep copy" behaviour is the
    // default — message stays in Inbox AND gets forwarded.
    // The matching inbox emails show the mailbox state while forwarding is active.
    log.info('E2E: creating email forwarding rule + test data (Section 41)…');
    try {
      const fwdTarget = toSenderObject(senderRotation.length > 0 ? senderRotation[0] : FALLBACK_EXTERNAL_SENDERS[0]);

      const fwdRule = await outlookClient.createInboxRule(userEmail, {
        displayName:  `QA - Email Forwarding: all mail → ${fwdTarget.address}`,
        sequence:     200,
        isEnabled:    true,
        conditions:   {},
        actions: {
          forwardTo: [{ emailAddress: { address: fwdTarget.address, name: fwdTarget.name || fwdTarget.address.split('@')[0] } }],
          stopProcessingRules: false,
        },
      });
      log.info(`✓ Forwarding rule created: "${fwdRule.displayName}"`);

      const fwdEmails = [
        {
          subject: 'QA E2E 41 - Forwarded Email #1 (Plain Text)',
          body:    { contentType: 'text', content: `This email would be forwarded to ${fwdTarget.address}. Tests account-level forwarding rule migration — keep-copy mode.` },
          from:    { emailAddress: externalSender },
          isRead:  false,
        },
        {
          subject: 'QA E2E 41 - Forwarded Email #2 (With Attachment)',
          body:    { contentType: 'text', content: `Email with attachment covered by forwarding rule → ${fwdTarget.address}. Tests forwarding + attachment.` },
          from:    { emailAddress: toSenderObject(senderRotation.length > 1 ? senderRotation[1] : FALLBACK_EXTERNAL_SENDERS[1]) },
          isRead:  true,
          attachments: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name:         'qa-fwd-attachment.txt',
            contentType:  'text/plain',
            contentBytes: Buffer.from('QA forwarding rule test attachment — section 41.').toString('base64'),
          }],
        },
        {
          subject: 'QA E2E 41 - Forwarded Email #3 (HTML)',
          body:    { contentType: 'html', content: '<html><body><p>HTML email covered by <strong>forwarding rule</strong> — kept in Inbox and forwarded. Tests forwarding with HTML content.</p></body></html>' },
          from:    { emailAddress: externalSender },
          isRead:  false,
        },
      ];

      for (const em of fwdEmails) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'inbox', {
            ...em,
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isDraft: false,
          });
          summary.messagesCreated++;
          log.info(`✓ 41: inserted "${em.subject}"`);
        } catch (e) {
          log.warn(`Section 41 email "${em.subject}" failed: ${e.message}`);
          summary.errors.push(`Section 41 "${em.subject}": ${e.message}`);
        }
      }
      log.info(`✓ Section 41 complete — forwarding rule + ${fwdEmails.length} inbox emails`);
    } catch (err) {
      log.warn(`Email forwarding section 41 failed: ${err.message}`);
      summary.errors.push(`Section 41 forwarding: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 43. Additional inbox rule condition: sentToAddresses ─────────────────
    // Complements sections 24A/24B (From-based routing) with a recipient-based
    // inbox rule that triggers when mail is addressed TO a specific address.
    // Covers the sentToAddresses condition type in Microsoft Graph inbox rules.
    log.info('E2E: creating SentTo inbox rule + test data (Section 43)…');
    try {
      const sentToFolder = 'QA-SentTo-Rule-Target';
      const sentToFolderId = await outlookClient.getOrCreateMailFolder(userEmail, sentToFolder);

      const sentToRule = await outlookClient.createInboxRule(userEmail, {
        displayName: `QA - SentTo Rule: route mail addressed to ${userEmail} → ${sentToFolder}`,
        sequence:    102,
        isEnabled:   true,
        conditions:  { sentToAddresses: [{ emailAddress: { address: userEmail, name: userEmail.split('@')[0] } }] },
        actions:     { moveToFolder: sentToFolderId, stopProcessingRules: false },
      });
      log.info(`✓ Rule 43 created: "${sentToRule.displayName}" → ${sentToFolder}`);
      if (!summary.foldersPopulated.includes(sentToFolder)) summary.foldersPopulated.push(sentToFolder);

      const sentToEmails = [
        {
          subject: `QA E2E 43 - SentTo Rule: Addressed-To Email #1`,
          body:    { contentType: 'text', content: `Email with To: ${userEmail} — should match sentToAddresses condition and be routed to ${sentToFolder}.` },
          from:    { emailAddress: externalSender },
          isRead:  false,
        },
        {
          subject: `QA E2E 43 - SentTo Rule: Addressed-To Email #2`,
          body:    { contentType: 'html', content: `<html><body><p>Second email directly addressed to <strong>${userEmail}</strong> — validates sentToAddresses rule routing.</p></body></html>` },
          from:    { emailAddress: toSenderObject(senderRotation.length > 0 ? senderRotation[0] : FALLBACK_EXTERNAL_SENDERS[0]) },
          isRead:  true,
        },
        {
          subject: `QA E2E 43 - SentTo Rule: Addressed-To with Attachment`,
          body:    { contentType: 'text', content: `Email with attachment addressed to ${userEmail} — tests sentToAddresses rule with attachment.` },
          from:    { emailAddress: externalSender },
          isRead:  false,
          attachments: [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name:          'qa-sentto-attachment.txt',
            contentType:   'text/plain',
            contentBytes:  Buffer.from('QA sentToAddresses rule test attachment — section 43.').toString('base64'),
          }],
        },
      ];

      // Deliver via the rule: send each mail addressed to the user so the sentToAddresses rule
      // routes it to the target folder. (Safe here: later seeded mail is either injected — no
      // transport, so rules don't fire — or sent To: a non-user address, e.g. the DL group.)
      const canSend43 = senderRotation.length >= 1;
      for (const em of sentToEmails) {
        try {
          const via = await this._deliverThroughRule(userEmail, {
            senderObj: em.from.emailAddress, targetFolderId: sentToFolderId,
            subject: em.subject, body: em.body.content, contentType: em.body.contentType,
            isRead: em.isRead, attachments: em.attachments, canSend: canSend43, log,
          });
          summary.messagesCreated++;
          log.info(`✓ 43: "${em.subject}" (${via === 'rule' ? 'routed by rule' : 'injected'})`);
        } catch (e) {
          log.warn(`Section 43 email "${em.subject}" failed: ${e.message}`);
          summary.errors.push(`Section 43 "${em.subject}": ${e.message}`);
        }
      }
      log.info(`✓ Section 43 complete — sentToAddresses rule + ${sentToEmails.length} matching emails`);
    } catch (err) {
      log.warn(`SentTo inbox rule section 43 failed: ${err.message}`);
      summary.errors.push(`Section 43 sentToAddresses rule: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 44. Deep thread chain (8-level, 4 participants, all system folders) ──
    // 10 messages total: 2 Inbox + 3 Sent Items + 1 Drafts + 1 Junk + 1 Deleted + 1 Archive + 1 Custom
    // Each message is linked via In-Reply-To + References headers so Exchange/Gmail
    // groups them into a single conversation thread for migration validation.
    log.info('E2E: creating deep thread chain — 10 messages, 4 participants, all folders (Section 44)…');
    try {
      const dtSubject = 'QA E2E 44 - Deep Thread Chain (Multi-Participant All Folders)';
      const dtRe      = `RE: ${dtSubject}`;
      const selfAddr44 = { address: userEmail, name: userEmail.split('@')[0] };
      const p1 = externalSender;   // pick(0) — primary sender
      const p2 = pick(1);          // second participant (CC early, TO later)
      const p3 = pick(2);          // third participant
      const p4 = pick(3);          // fourth participant — joins mid-thread

      const msgIds = [];
      const refs   = () => msgIds.filter(Boolean).join(' ');

      // ── Msg 1: Inbox — p1 opens thread, CC: p2, p3
      const m1 = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      dtSubject,
        body:         { contentType: 'HTML', content: '<p><b>Thread start</b> — please review and share thoughts. CC-ing the team.</p>' },
        from:         { emailAddress: p1 },
        toRecipients: [{ emailAddress: selfAddr44 }],
        ccRecipients: [{ emailAddress: p2 }, { emailAddress: p3 }],
        isRead: true, isDraft: false,
      });
      summary.messagesCreated++;
      msgIds.push(m1.internetMessageId || '');

      // ── Msg 2: Sent Items — user replies to all, adds p4 to CC
      const m2 = await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>Thanks — adding Granger to the loop. Inline comments below.</p>' },
        from:         { emailAddress: selfAddr44 },
        toRecipients: [{ emailAddress: p1 }, { emailAddress: p2 }],
        ccRecipients: [{ emailAddress: p3 }, { emailAddress: p4 }],
        isRead: true, isDraft: false,
        inReplyTo:  msgIds[0],
        references: refs(),
      });
      summary.messagesCreated++;
      msgIds.push(m2.internetMessageId || '');

      // ── Msg 3: Inbox — p1 replies to all, now full group in TO — with 1 attachment (the notes)
      const m3 = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>Agreed. Can someone confirm the Q3 timeline? See attached notes.</p>' },
        from:         { emailAddress: p1 },
        toRecipients: [{ emailAddress: selfAddr44 }, { emailAddress: p2 }, { emailAddress: p3 }],
        ccRecipients: [{ emailAddress: p4 }],
        isRead: true, isDraft: false,
        inReplyTo:  msgIds[1],
        references: refs(),
        attachments: [
          { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-thread-notes.txt', contentType: 'text/plain', contentBytes: Buffer.from('Thread notes — Q3 timeline discussion and action items.').toString('base64') },
        ],
      });
      summary.messagesCreated++;
      msgIds.push(m3.internetMessageId || '');

      // ── Msg 4: Sent Items — user confirms timeline, TO: all 3 external
      const m4 = await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>Timeline confirmed for Q3. Kick-off scheduled for first Monday. Let me know if conflicts.</p>' },
        from:         { emailAddress: selfAddr44 },
        toRecipients: [{ emailAddress: p1 }, { emailAddress: p2 }, { emailAddress: p3 }],
        ccRecipients: [{ emailAddress: p4 }],
        isRead: true, isDraft: false,
        inReplyTo:  msgIds[2],
        references: refs(),
      });
      summary.messagesCreated++;
      msgIds.push(m4.internetMessageId || '');

      // ── Msg 5: Sent Items — user sends follow-up with 3 attachments (agenda + review docs)
      const m5 = await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>Follow-up: agenda doc attached for kick-off review.</p>' },
        from:         { emailAddress: selfAddr44 },
        toRecipients: [{ emailAddress: p1 }, { emailAddress: p2 }, { emailAddress: p3 }, { emailAddress: p4 }],
        ccRecipients: [],
        isRead: true, isDraft: false,
        inReplyTo:  msgIds[3],
        references: refs(),
        attachments: [
          { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-kickoff-agenda.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: MINIMAL_DOCX_B64 },
          { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-kickoff-review.pdf', contentType: 'application/pdf', contentBytes: MINIMAL_PDF_B64 },
          { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-kickoff-checklist.txt', contentType: 'text/plain', contentBytes: Buffer.from('Kick-off checklist: agenda, owners, dates, risks.').toString('base64') },
        ],
      });
      summary.messagesCreated++;
      msgIds.push(m5.internetMessageId || '');

      // ── Msg 6: Inbox — p2 moves to TO, replies with approval
      const m6 = await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>Q3 works for us — agenda looks good. Confirmed on our end.</p>' },
        from:         { emailAddress: p2 },
        toRecipients: [{ emailAddress: selfAddr44 }, { emailAddress: p1 }, { emailAddress: p3 }],
        ccRecipients: [{ emailAddress: p4 }],
        isRead: false, isDraft: false,
        inReplyTo:  msgIds[4],
        references: refs(),
      });
      summary.messagesCreated++;
      msgIds.push(m6.internetMessageId || '');

      // ── Msg 7: Drafts — user started reply 7 but never sent it
      await outlookClient.createMessageInFolder(userEmail, 'drafts', {
        subject:      dtRe,
        body:         { contentType: 'HTML', content: '<p>One more thing I wanted to clarify before closing — </p>' },
        from:         { emailAddress: selfAddr44 },
        toRecipients: [{ emailAddress: p1 }, { emailAddress: p2 }],
        ccRecipients: [{ emailAddress: p3 }, { emailAddress: p4 }],
        isRead: true, isDraft: true,
        inReplyTo:  msgIds[5],
        references: refs(),
      });
      summary.messagesCreated++;

      // ── Msg 8: Junk Email — p3 reply auto-filtered to junk
      await outlookClient.createMessageInFolder(userEmail, 'junkemail', {
        subject:      dtRe,
        body:         { contentType: 'text', content: 'Forwarding the agenda link — got auto-filtered to Junk. Should appear in Gmail Spam.' },
        from:         { emailAddress: p3 },
        toRecipients: [{ emailAddress: selfAddr44 }],
        ccRecipients: [{ emailAddress: p1 }, { emailAddress: p2 }],
        isRead: false, isDraft: false,
        inReplyTo:  msgIds[3],
        references: refs(),
      });
      summary.messagesCreated++;

      // ── Msg 9: Deleted Items — p4 mid-thread reply that user deleted
      await outlookClient.createMessageInFolder(userEmail, 'deleteditems', {
        subject:      dtRe,
        body:         { contentType: 'text', content: 'Deleted mid-thread reply — should appear in Gmail Trash after migration.' },
        from:         { emailAddress: p4 },
        toRecipients: [{ emailAddress: selfAddr44 }, { emailAddress: p1 }],
        ccRecipients: [{ emailAddress: p2 }],
        isRead: true, isDraft: false,
        inReplyTo:  msgIds[1],
        references: refs(),
      });
      summary.messagesCreated++;

      // ── Msg 10: Archive — user archived the original message
      await outlookClient.createMessageInFolder(userEmail, 'archive', {
        subject:      dtSubject,
        body:         { contentType: 'text', content: 'Archived copy of thread opening email — tests thread migration across Archive folder.' },
        from:         { emailAddress: p1 },
        toRecipients: [{ emailAddress: selfAddr44 }],
        ccRecipients: [{ emailAddress: p2 }, { emailAddress: p3 }],
        isRead: true, isDraft: false,
      });
      summary.messagesCreated++;

      log.info('✓ Section 44 complete — 10-message deep thread chain across Inbox×2, Sent×3, Drafts, Junk, Deleted, Archive with 4 participants (attachments: 1 on Msg 3, 3 on Msg 5)');
    } catch (err) {
      log.warn(`Section 44 deep thread chain failed: ${err.message}`);
      summary.errors.push(`Section 44 deep thread chain: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 45. Quality coverage — system folder attachment/flag/importance gaps ─
    log.info('E2E: section 45 — quality coverage for Sent, Archive, Drafts, Junk, Deleted…');
    try {
      const s45Self   = { address: userEmail, name: userEmail.split('@')[0] };
      const s45Ext    = pick(0);
      const s45Ext2   = pick(1);
      const s45Ext3   = pick(2);
      const b64s45    = (s) => Buffer.from(s).toString('base64');

      const s45Pdf  = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-report.pdf',    contentType: 'application/pdf',    contentBytes: MINIMAL_PDF_B64 };
      const s45Docx = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-document.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', contentBytes: MINIMAL_DOCX_B64 };
      const s45Xlsx = () => {
        const wb = XLSX_LIB.utils.book_new();
        XLSX_LIB.utils.book_append_sheet(wb, XLSX_LIB.utils.aoa_to_sheet([['ID','Subject','Status'],[1,'QA Row 1','Pass'],[2,'QA Row 2','Pass']]), 'QA');
        return { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-data.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBytes: XLSX_LIB.write(wb, { type: 'base64', bookType: 'xlsx' }) };
      };
      const s45Txt  = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-notes.txt', contentType: 'text/plain', contentBytes: b64s45('QA migration test attachment — plain text notes for verification.') };
      const s45Png  = { '@odata.type': '#microsoft.graph.fileAttachment', name: 'qa-inline.png',  contentType: 'image/png', contentBytes: makeSolidColorPng(0, 120, 215), contentId: 'qa-inline-45@test', isInline: true };

      // ── 45a. Sent Items gaps ──────────────────────────────────────────────
      const sentCases45 = [
        {
          label: 'Sent PDF Attachment',
          msg: {
            subject: 'QA E2E 45a-1 - Sent With PDF Attachment',
            body: { contentType: 'HTML', content: '<html><body><p>Sent email with <strong>PDF attachment</strong>. Migration QA — verifies attachment survives in Sent Items → Gmail Sent.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            isRead: true, isDraft: false,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Sent DOCX+XLSX Multi-Attach with CC',
          msg: {
            subject: 'QA E2E 45a-2 - Sent Multiple Attachments (DOCX+XLSX) With CC',
            body: { contentType: 'HTML', content: '<html><body><p>Sent email with <em>multiple attachments</em> (Word + Excel) and a CC recipient.</p><p>Tests multi-attachment preservation and CC in Sent Items.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            ccRecipients: [{ emailAddress: s45Ext2 }],
            isRead: true, isDraft: false,
            attachments: [s45Docx, s45Xlsx()],
          },
        },
        {
          label: 'Sent BCC-Only (no TO)',
          msg: {
            subject: 'QA E2E 45a-3 - Sent BCC Only (Empty TO)',
            body: { contentType: 'text', content: 'Sent email with only BCC recipients — TO field is empty. Tests BCC-only sent email migration to Gmail.' },
            from: { emailAddress: s45Self },
            toRecipients: [],
            bccRecipients: [{ emailAddress: s45Ext }, { emailAddress: s45Ext2 }],
            isRead: true, isDraft: false,
          },
        },
        {
          label: 'Sent Flagged + High Importance',
          msg: {
            subject: 'QA E2E 45a-4 - Sent Flagged High Importance',
            body: { contentType: 'text', content: 'Sent email marked as flagged and high importance. Verifies importance + flag state migrate from Sent Items.' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            isRead: true, isDraft: false,
            flag: { flagStatus: 'flagged' },
            importance: 'high',
          },
        },
        {
          label: 'Sent Reply With PDF Attachment',
          msg: {
            subject: 'Re: QA E2E 45a-5 - Sent Reply With Attachment',
            body: { contentType: 'HTML', content: '<html><body><p>Reply sent with a PDF attachment. Tests that replied-sent emails with attachments migrate correctly.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            ccRecipients: [{ emailAddress: s45Ext2 }],
            isRead: true, isDraft: false,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Sent Forward With DOCX Attachment',
          msg: {
            subject: 'Fwd: QA E2E 45a-6 - Sent Forward With Attachment',
            body: { contentType: 'HTML', content: '<html><body><p>Forwarded sent email with a DOCX attachment.</p><p>Tests Fwd: subject prefix and attachment preservation in Sent Items.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext3 }],
            isRead: true, isDraft: false,
            attachments: [s45Docx],
          },
        },
        {
          label: 'Sent HTML Inline Image',
          msg: {
            subject: 'QA E2E 45a-7 - Sent HTML With Inline Image',
            body: { contentType: 'HTML', content: '<html><body><p>Sent email with inline image embedded in body.</p><img src="cid:qa-inline-45@test" alt="QA inline" style="width:80px;height:80px;"/><p>Tests inline image CID migration in Sent Items.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            isRead: true, isDraft: false,
            attachments: [s45Png],
          },
        },
        {
          label: 'Sent High Importance Multiple TO + Attachment',
          msg: {
            subject: 'QA E2E 45a-8 - Sent High Importance Multiple TO With Attachment',
            body: { contentType: 'HTML', content: '<html><body><p><strong>HIGH IMPORTANCE</strong> — sent to multiple recipients with a PDF attachment.</p><p>Tests importance flag + multi-TO + attachment combo in Sent Items.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }, { emailAddress: s45Ext2 }, { emailAddress: s45Ext3 }],
            isRead: true, isDraft: false,
            importance: 'high',
            attachments: [s45Pdf, s45Txt],
          },
        },
      ];

      for (const tc of sentCases45) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'sentitems', tc.msg);
          summary.messagesCreated++;
          log.info(`✓ 45a Sent: "${tc.label}"`);
        } catch (err) {
          log.warn(`45a Sent "${tc.label}" failed: ${err.message}`);
          summary.errors.push(`45a Sent "${tc.label}": ${err.message}`);
        }
      }

      if (context.executionId && executionService.isCancelled(context.executionId)) return;

      // ── 45b. Archive gaps ─────────────────────────────────────────────────
      const archiveCases45 = [
        {
          label: 'Archive PDF + HTML',
          msg: {
            subject: 'QA E2E 45b-1 - Archive PDF Attachment HTML Body',
            body: { contentType: 'HTML', content: '<html><body><p>Archived email with <strong>PDF attachment</strong> and HTML body. Tests attachment preservation in Archive folder.</p></body></html>' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Archive CC + BCC',
          msg: {
            subject: 'QA E2E 45b-2 - Archive With CC and BCC',
            body: { contentType: 'text', content: 'Archived email with CC and BCC recipients. Tests recipient field preservation in Archive folder migration.' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients:  [{ emailAddress: s45Ext2 }],
            bccRecipients: [{ emailAddress: s45Ext3 }],
            isRead: true, isDraft: false,
          },
        },
        {
          label: 'Archive High Importance Flagged',
          msg: {
            subject: 'QA E2E 45b-3 - Archive High Importance Flagged',
            body: { contentType: 'text', content: 'Archived email with high importance flag. Tests importance and flag state in Archive folder.' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            flag: { flagStatus: 'flagged' },
            importance: 'high',
          },
        },
        {
          label: 'Archive Multiple Attachments PDF+DOCX',
          msg: {
            subject: 'QA E2E 45b-4 - Archive Multiple Attachments (PDF+DOCX)',
            body: { contentType: 'HTML', content: '<html><body><p>Archived email with <em>multiple attachment types</em> (PDF + Word document).</p><p>Tests multi-attachment count and type fidelity in Archive.</p></body></html>' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            attachments: [s45Pdf, s45Docx],
          },
        },
        {
          label: 'Archive Reply Chain With Attachment',
          msg: {
            subject: 'Re: QA E2E 45b-5 - Archive Reply With Attachment',
            body: { contentType: 'HTML', content: '<html><body><p>Archived reply email with a TXT attachment.</p><p>Tests Re: subject prefix + attachment in Archive folder.</p></body></html>' },
            from: { emailAddress: s45Ext3 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients: [{ emailAddress: s45Ext }],
            isRead: true, isDraft: false,
            attachments: [s45Txt],
          },
        },
        {
          label: 'Archive Unread With XLSX',
          msg: {
            subject: 'QA E2E 45b-6 - Archive Unread XLSX Attachment',
            body: { contentType: 'text', content: 'Archived unread email with an Excel spreadsheet attachment.' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: false, isDraft: false,
            attachments: [s45Xlsx()],
          },
        },
      ];

      for (const tc of archiveCases45) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'archive', tc.msg);
          summary.messagesCreated++;
          if (!summary.foldersPopulated.includes('Archive')) summary.foldersPopulated.push('Archive');
          log.info(`✓ 45b Archive: "${tc.label}"`);
        } catch (err) {
          log.warn(`45b Archive "${tc.label}" failed: ${err.message}`);
          summary.errors.push(`45b Archive "${tc.label}": ${err.message}`);
        }
      }

      if (context.executionId && executionService.isCancelled(context.executionId)) return;

      // ── 45c. Drafts gaps ──────────────────────────────────────────────────
      const draftCases45 = [
        {
          label: 'Draft PDF Attachment',
          msg: {
            subject: 'QA E2E 45c-1 - Draft With PDF Attachment',
            body: { contentType: 'HTML', content: '<html><body><p>Draft email with a <strong>PDF attachment</strong>. Tests attachment preservation in Drafts folder.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            isRead: false, isDraft: true,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Draft Multiple Attachments DOCX+PDF',
          msg: {
            subject: 'QA E2E 45c-2 - Draft Multiple Attachments (DOCX+PDF)',
            body: { contentType: 'HTML', content: '<html><body><p>Draft with multiple attachment types (Word + PDF). Tests multi-type attachment in Drafts.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            ccRecipients: [{ emailAddress: s45Ext2 }],
            isRead: false, isDraft: true,
            attachments: [s45Docx, s45Pdf],
          },
        },
        {
          label: 'Draft CC + TXT Attachment',
          msg: {
            subject: 'QA E2E 45c-3 - Draft CC With TXT Attachment',
            body: { contentType: 'text', content: 'Draft email with CC and a plain text attachment. Tests CC recipient + attachment combo in Drafts.' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            ccRecipients: [{ emailAddress: s45Ext2 }, { emailAddress: s45Ext3 }],
            isRead: false, isDraft: true,
            attachments: [s45Txt],
          },
        },
        {
          label: 'Draft High Importance',
          msg: {
            subject: 'QA E2E 45c-4 - Draft High Importance',
            body: { contentType: 'HTML', content: '<html><body><p><strong>High importance</strong> draft email. Tests importance flag on drafts migrating to Gmail.</p></body></html>' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            isRead: false, isDraft: true,
            importance: 'high',
          },
        },
        {
          label: 'Draft BCC + XLSX Attachment',
          msg: {
            subject: 'QA E2E 45c-5 - Draft BCC With XLSX Attachment',
            body: { contentType: 'text', content: 'Draft with BCC recipients and an Excel spreadsheet attachment. Tests BCC + attachment preservation in Drafts.' },
            from: { emailAddress: s45Self },
            toRecipients: [{ emailAddress: s45Ext }],
            bccRecipients: [{ emailAddress: s45Ext3 }],
            isRead: false, isDraft: true,
            attachments: [s45Xlsx()],
          },
        },
      ];

      for (const tc of draftCases45) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'drafts', tc.msg);
          summary.messagesCreated++;
          log.info(`✓ 45c Draft: "${tc.label}"`);
        } catch (err) {
          log.warn(`45c Draft "${tc.label}" failed: ${err.message}`);
          summary.errors.push(`45c Draft "${tc.label}": ${err.message}`);
        }
      }

      if (context.executionId && executionService.isCancelled(context.executionId)) return;

      // ── 45d. Junk Email gaps ──────────────────────────────────────────────
      const junkCases45 = [
        {
          label: 'Junk PDF + HTML',
          msg: {
            subject: 'QA E2E 45d-1 - Junk PDF Attachment HTML Body',
            body: { contentType: 'HTML', content: '<html><body><p>Junk/spam email with <strong>PDF attachment</strong> and HTML body.</p><p>Tests attachment preservation in Junk Email → Gmail Spam.</p></body></html>' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: false, isDraft: false,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Junk With CC Recipients',
          msg: {
            subject: 'QA E2E 45d-2 - Junk With CC Recipients',
            body: { contentType: 'text', content: 'Junk email with CC recipients — tests CC preservation in Junk/Spam folder migration.' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients: [{ emailAddress: s45Ext3 }],
            isRead: false, isDraft: false,
          },
        },
        {
          label: 'Junk High Importance (False Positive)',
          msg: {
            subject: 'QA E2E 45d-3 - Junk High Importance False Positive',
            body: { contentType: 'HTML', content: '<html><body><p>Junk email marked as <strong>high importance</strong> — simulates false-positive spam classification.</p><p>Tests importance flag in Junk folder migration.</p></body></html>' },
            from: { emailAddress: s45Ext3 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: false, isDraft: false,
            importance: 'high',
          },
        },
        {
          label: 'Junk DOCX Attachment',
          msg: {
            subject: 'QA E2E 45d-4 - Junk DOCX Attachment',
            body: { contentType: 'text', content: 'Junk email with a Word document attachment. Tests DOCX attachment preservation in Junk → Gmail Spam.' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            attachments: [s45Docx],
          },
        },
        {
          label: 'Junk Multiple Attachments PDF+TXT',
          msg: {
            subject: 'QA E2E 45d-5 - Junk Multiple Attachments (PDF+TXT)',
            body: { contentType: 'HTML', content: '<html><body><p>Junk email with multiple attachments (PDF + TXT). Tests multi-attachment count in Junk Email folder.</p></body></html>' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients: [{ emailAddress: s45Ext3 }],
            isRead: false, isDraft: false,
            attachments: [s45Pdf, s45Txt],
          },
        },
      ];

      for (const tc of junkCases45) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'junkemail', tc.msg);
          summary.messagesCreated++;
          log.info(`✓ 45d Junk: "${tc.label}"`);
        } catch (err) {
          log.warn(`45d Junk "${tc.label}" failed: ${err.message}`);
          summary.errors.push(`45d Junk "${tc.label}": ${err.message}`);
        }
      }

      if (context.executionId && executionService.isCancelled(context.executionId)) return;

      // ── 45e. Deleted Items gaps ───────────────────────────────────────────
      const deletedCases45 = [
        {
          label: 'Deleted PDF + HTML',
          msg: {
            subject: 'QA E2E 45e-1 - Deleted PDF Attachment HTML Body',
            body: { contentType: 'HTML', content: '<html><body><p>Deleted email with <strong>PDF attachment</strong> and HTML body.</p><p>Tests attachment preservation in Deleted Items → Gmail Trash.</p></body></html>' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: true, isDraft: false,
            attachments: [s45Pdf],
          },
        },
        {
          label: 'Deleted With CC',
          msg: {
            subject: 'QA E2E 45e-2 - Deleted With CC Recipients',
            body: { contentType: 'text', content: 'Deleted email with CC recipients. Tests CC field preservation in Deleted Items → Gmail Trash migration.' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients: [{ emailAddress: s45Ext3 }, { emailAddress: s45Ext }],
            isRead: true, isDraft: false,
          },
        },
        {
          label: 'Deleted High Importance',
          msg: {
            subject: 'QA E2E 45e-3 - Deleted High Importance',
            body: { contentType: 'HTML', content: '<html><body><p><strong>High importance</strong> deleted email. Tests importance preservation in Deleted Items folder.</p></body></html>' },
            from: { emailAddress: s45Ext3 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: false, isDraft: false,
            importance: 'high',
          },
        },
        {
          label: 'Deleted Multiple Attachments DOCX+XLSX',
          msg: {
            subject: 'QA E2E 45e-4 - Deleted Multiple Attachments (DOCX+XLSX)',
            body: { contentType: 'HTML', content: '<html><body><p>Deleted email with multiple attachments (Word + Excel).</p><p>Tests multi-attachment count and type in Deleted Items → Trash migration.</p></body></html>' },
            from: { emailAddress: s45Ext },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            isRead: false, isDraft: false,
            attachments: [s45Docx, s45Xlsx()],
          },
        },
        {
          label: 'Deleted Flagged With TXT Attachment',
          msg: {
            subject: 'QA E2E 45e-5 - Deleted Flagged With TXT Attachment',
            body: { contentType: 'text', content: 'Deleted email that was flagged before deletion, with a text attachment. Tests flag state + attachment in Deleted Items.' },
            from: { emailAddress: s45Ext2 },
            toRecipients: [{ emailAddress: { address: userEmail } }],
            ccRecipients: [{ emailAddress: s45Ext3 }],
            isRead: true, isDraft: false,
            flag: { flagStatus: 'flagged' },
            attachments: [s45Txt],
          },
        },
      ];

      for (const tc of deletedCases45) {
        try {
          await outlookClient.createMessageInFolder(userEmail, 'deleteditems', tc.msg);
          summary.messagesCreated++;
          log.info(`✓ 45e Deleted: "${tc.label}"`);
        } catch (err) {
          log.warn(`45e Deleted "${tc.label}" failed: ${err.message}`);
          summary.errors.push(`45e Deleted "${tc.label}": ${err.message}`);
        }
      }

      log.info('✓ Section 45 complete — 29 quality-coverage emails added (8 Sent, 6 Archive, 5 Drafts, 5 Junk, 5 Deleted)');
    } catch (err) {
      log.warn(`Section 45 quality coverage failed: ${err.message}`);
      summary.errors.push(`Section 45: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── Missing scenario 1: Large body email (~50 KB) ────────────────────────
    log.info('E2E: creating large body email (~50 KB)…');
    try {
      const largeParagraph = 'Migration QA large body paragraph. ' +
        'This email contains approximately fifty thousand characters of body text to exercise body size handling. ' +
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ';
      const largeBodyText = largeParagraph.repeat(Math.ceil(50000 / largeParagraph.length)).slice(0, 50000);
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E - Large Body Email (~50KB)',
        body:         { contentType: 'text', content: largeBodyText },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
      });
      summary.messagesCreated++;
      log.info(`✓ Large body email (~50 KB) created (body length=${largeBodyText.length} chars)`);
    } catch (err) {
      log.warn(`Large body email (~50 KB) failed: ${err.message}`);
      summary.errors.push(`Large body email (~50KB): ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── Missing scenario 2: Draft with no recipients ─────────────────────────
    log.info('E2E: creating draft with no recipients…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'drafts', {
        subject:       'QA E2E - Draft With No Recipients',
        body:          { contentType: 'text', content: 'Draft email with no To/CC/BCC recipients — tests incomplete draft migration where recipient fields are empty.' },
        from:          { emailAddress: { address: userEmail } },
        toRecipients:  [],
        ccRecipients:  [],
        bccRecipients: [],
        isRead: false, isDraft: true,
      });
      summary.messagesCreated++;
      log.info('✓ Draft with no recipients created');
    } catch (err) {
      log.warn(`Draft with no recipients failed: ${err.message}`);
      summary.errors.push(`Draft with no recipients: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── Missing scenario 3: DOCX attachment email ────────────────────────────
    log.info('E2E: creating DOCX attachment email…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E - DOCX Attachment Test',
        body:         { contentType: 'text', content: 'Email with a Word document (.docx) attachment — tests DOCX attachment type migration.' },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false, isDraft: false,
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-migration-document.docx',
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          contentBytes: MINIMAL_DOCX_B64,
        }],
      });
      summary.messagesCreated++;
      log.info('✓ DOCX attachment email created');
    } catch (err) {
      log.warn(`DOCX attachment email failed: ${err.message}`);
      summary.errors.push(`DOCX attachment email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 46. Shared Mailbox ───────────────────────────────────────────────────
    // Graph cannot CREATE a shared mailbox (Exchange-only), so a real one must be
    // provisioned once in the Admin Center and its address set in SHARED_MAILBOX_ADDRESS.
    // When configured, we seed REAL content INTO that shared mailbox via Graph app-only
    // (so it can be migrated/validated as a genuine shared mailbox) AND drop a message in
    // the source user's inbox that genuinely originates from the shared mailbox address.
    // When NOT configured, we fall back to a From-header-only simulation.
    const sharedMailbox = env.SHARED_MAILBOX_ADDRESS;
    const sharedAddr = sharedMailbox || 'sharedmailbox@qatestagent.com';
    log.info(sharedMailbox
      ? `E2E: seeding real shared mailbox ${sharedMailbox} (Section 46)…`
      : 'E2E: creating shared mailbox simulation — SHARED_MAILBOX_ADDRESS not set (Section 46)…');

    // 46a. Seed real content INTO the shared mailbox itself (only when provisioned).
    if (sharedMailbox) {
      try {
        await outlookClient.createMessageInFolder(sharedMailbox, 'inbox', {
          subject: 'QA E2E - Shared Mailbox Received Email',
          body: {
            contentType: 'HTML',
            content: '<html><body><p>Received email inside the shared mailbox — validates that a '
              + 'shared mailbox\'s own content migrates with shared access preserved.</p></body></html>',
          },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: sharedMailbox, name: 'Shared Mailbox' } }],
          isRead: false,
          isDraft: false,
        });
        summary.messagesCreated++;
        log.info(`✓ Seeded content into real shared mailbox ${sharedMailbox}`);
      } catch (err) {
        log.warn(`Seeding shared mailbox ${sharedMailbox} failed: ${err.message}`);
        summary.errors.push(`Shared mailbox seed (${sharedMailbox}): ${err.message}`);
      }
    }

    // 46b. Message in the source user's inbox originating from the shared mailbox address.
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject:      'QA E2E - Shared Mailbox Email Test',
        body: {
          contentType: 'HTML',
          content: '<html><body>'
            + `<p>This email ${sharedMailbox ? 'was received from' : 'simulates a message received from'} a shared mailbox.</p>`
            + `<p><strong>Shared Mailbox:</strong> ${sharedAddr}</p>`
            + '<p>Migration QA — verifies that emails originating from a shared mailbox address '
            + 'are migrated with the correct From header, body, and folder placement.</p>'
            + '</body></html>',
        },
        from:         { emailAddress: { address: sharedAddr, name: 'Shared Mailbox QA' } },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false,
        isDraft: false,
      });
      summary.messagesCreated++;
      log.info(`✓ Shared mailbox email created (${sharedAddr} → Inbox)`);
    } catch (err) {
      log.warn(`Shared mailbox email failed: ${err.message}`);
      summary.errors.push(`Shared mailbox email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 47. Distribution List / Group email ─────────────────────────────────
    // Uses the REAL mail-enabled group created in §21 (with real members) when available:
    // a member sends TO the group address and we poll the source inbox for live fan-out.
    // If fan-out doesn't land in time (M365 group provisioning can lag), or no real group
    // exists, we inject the email directly with the group address as To. Either way the
    // source mailbox ends with an email addressed to a distribution list.
    log.info('E2E: creating distribution list email (Section 47)…');
    const dlAddress = distributionListAddress || 'qa-dist-list@qatestagent.com';
    const dlSubject = 'QA E2E - Distribution List Email Test';
    const dlBody = {
      contentType: 'HTML',
      content: '<html><body>'
        + '<p>This email was sent to a distribution list address.</p>'
        + `<p><strong>Distribution List:</strong> ${dlAddress}</p>`
        + '<p>Migration QA — verifies that emails addressed to distribution list / group '
        + 'addresses are migrated with the original To/CC fields intact.</p>'
        + '</body></html>',
    };
    const dlTo = [{ emailAddress: { address: dlAddress, name: 'QA Distribution List' } }];
    const dlCc = [{ emailAddress: { address: userEmail } }];

    let dlDelivered = false;
    if (distributionListAddress && dlLiveSender) {
      try {
        log.info(`§47: live-sending DL email from ${dlLiveSender} → ${dlAddress} (fan-out to members)…`);
        await outlookClient.sendMailAsUser(
          dlLiveSender,
          { subject: dlSubject, body: dlBody, toRecipients: dlTo, ccRecipients: dlCc },
          true
        );
        // Poll the source inbox for fan-out arrival (group provisioning/delivery can lag).
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          try {
            const cnt = await outlookClient.countMessagesBySubjectPrefix(userEmail, dlSubject);
            if (cnt > 0) { dlDelivered = true; break; }
          } catch (_) { /* keep polling */ }
        }
        log.info(dlDelivered
          ? '✓ DL email delivered via live fan-out through the group'
          : 'DL live fan-out not received within 90s — falling back to direct inject');
      } catch (err) {
        log.warn(`DL live send failed: ${err.message} — falling back to direct inject`);
      }
    }

    if (!dlDelivered) {
      try {
        await outlookClient.createMessageInFolder(userEmail, 'inbox', {
          subject: dlSubject,
          body: dlBody,
          from:         { emailAddress: externalSender },
          toRecipients: dlTo,
          ccRecipients: dlCc,
          isRead: false,
          isDraft: false,
        });
        summary.messagesCreated++;
        log.info(`✓ Distribution list email injected (TO: ${dlAddress}, CC: user)`);
      } catch (err) {
        log.warn(`Distribution list email failed: ${err.message}`);
        summary.errors.push(`Distribution list email: ${err.message}`);
      }
    } else {
      summary.messagesCreated++;
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 48. Email with HTML signature block in body ──────────────────────────
    // Tests that a full HTML email signature embedded at the bottom of the body
    // migrates correctly — fonts, colors, links, and formatting all preserved.
    log.info('E2E: creating email with HTML signature block in body (Section 48)…');
    try {
      await outlookClient.createMessageInFolder(userEmail, 'inbox', {
        subject: 'QA E2E - Signature in Body Test',
        body: {
          contentType: 'HTML',
          content: '<html><body style="font-family:Arial,sans-serif;font-size:14px;">'
            + '<p>Hi,</p>'
            + '<p>Please find the details you requested in the attachment.</p>'
            + '<p>Let me know if you have any questions.</p>'
            + '<p>Best regards,</p>'
            + '<br/>'
            + '<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#333;">'
            + '  <tr>'
            + '    <td style="border-right:3px solid #1a56db;padding-right:12px;vertical-align:top;">'
            + '      <strong style="font-size:15px;color:#1a56db;">John Q. Tester</strong><br/>'
            + '      <span style="color:#555;">Senior QA Engineer</span><br/>'
            + '      <span style="color:#555;">CloudFuze, Inc.</span>'
            + '    </td>'
            + '    <td style="padding-left:12px;vertical-align:top;">'
            + '      &#128222; <a href="tel:+15550001234" style="color:#333;text-decoration:none;">+1 (555) 000-1234</a><br/>'
            + '      &#9993; <a href="mailto:john.tester@qatestagent.com" style="color:#1a56db;">john.tester@qatestagent.com</a><br/>'
            + '      &#127758; <a href="https://www.cloudfuze.com" style="color:#1a56db;">www.cloudfuze.com</a>'
            + '    </td>'
            + '  </tr>'
            + '  <tr>'
            + '    <td colspan="2" style="padding-top:8px;font-size:10px;color:#999;">'
            + '      This email and any attachments are for the exclusive and confidential use of the intended recipient. '
            + '      If you are not the intended recipient, please do not read, distribute or take action in reliance upon this message.'
            + '    </td>'
            + '  </tr>'
            + '</table>'
            + '</body></html>',
        },
        from:         { emailAddress: externalSender },
        toRecipients: [{ emailAddress: { address: userEmail } }],
        isRead: false,
        isDraft: false,
      });
      summary.messagesCreated++;
      log.info('✓ Email with HTML signature block in body created');
    } catch (err) {
      log.warn(`Signature in body email failed: ${err.message}`);
      summary.errors.push(`Signature in body email: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── 49. Duplicate-subject test case (Sent Items) ─────────────────────────
    // Every seeded mail has a UNIQUE subject so subject-based pairing stays unambiguous.
    // This is the ONE deliberate exception: two Sent items sharing an identical subject,
    // so validation can confirm the allowed same-subject-pair case (and flag any others).
    log.info('E2E: creating duplicate-subject Sent pair (Section 49)…');
    const dupSubject = 'QA E2E - Duplicate Subject (Sent Pair)';
    for (let i = 1; i <= 2; i++) {
      try {
        await outlookClient.createMessageInFolder(userEmail, 'sentitems', {
          subject: dupSubject,
          body: {
            contentType: 'HTML',
            content: `<html><body><p>Sent copy ${i} of a deliberately duplicated subject — validates the `
              + 'allowed same-subject pair in Sent Items (all other mails must have unique subjects).</p></body></html>',
          },
          from:         { emailAddress: { address: userEmail, name: userEmail.split('@')[0] } },
          toRecipients: [{ emailAddress: pick(i) }],
          isRead: true,
          isDraft: false,
        });
        summary.messagesCreated++;
      } catch (err) {
        log.warn(`Duplicate-subject Sent mail ${i} failed: ${err.message}`);
        summary.errors.push(`Duplicate-subject Sent mail ${i}: ${err.message}`);
      }
    }
    log.info(`✓ Duplicate-subject Sent pair created ("${dupSubject}")`);

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-Cal. Calendar events (DELTA only) ────────────────────────────────
    if (context.migrationType === 'DELTA') {
    log.info('E2E (DELTA): creating calendar events…');
    const defaultCalId = null;

    const pastStart  = new Date(now); pastStart.setDate(pastStart.getDate() - 7);
    const pastEnd    = new Date(pastStart); pastEnd.setHours(pastEnd.getHours() + 1);
    const futureStart = new Date(now); futureStart.setDate(futureStart.getDate() + 7);
    const futureEnd   = new Date(futureStart); futureEnd.setHours(futureEnd.getHours() + 1);
    const recurStart  = new Date(now); recurStart.setDate(recurStart.getDate() + 14);
    const recurEnd    = new Date(recurStart); recurEnd.setHours(recurEnd.getHours() + 1);
    const multiDayStart = new Date(now); multiDayStart.setDate(multiDayStart.getDate() + 21);
    const multiDayEnd   = new Date(multiDayStart); multiDayEnd.setDate(multiDayEnd.getDate() + 2);

    const calEvents = [
      {
        label: 'past event',
        body: {
          subject: 'QA E2E - Past Calendar Event',
          start: { dateTime: pastStart.toISOString(), timeZone: 'UTC' },
          end:   { dateTime: pastEnd.toISOString(),   timeZone: 'UTC' },
          body:  { contentType: 'text', content: 'Past calendar event for migration QA.' },
          isAllDay: false,
        },
      },
      {
        label: 'present/all-day event',
        body: {
          subject: 'QA E2E - Present All-Day Event',
          start: { dateTime: now.toISOString().split('T')[0] + 'T00:00:00', timeZone: 'UTC' },
          end:   { dateTime: now.toISOString().split('T')[0] + 'T23:59:59', timeZone: 'UTC' },
          body:  { contentType: 'text', content: 'All-day event (today) for migration QA.' },
          isAllDay: true,
        },
      },
      {
        label: 'future event',
        body: {
          subject: 'QA E2E - Future Calendar Event',
          start: { dateTime: futureStart.toISOString(), timeZone: 'UTC' },
          end:   { dateTime: futureEnd.toISOString(),   timeZone: 'UTC' },
          body:  { contentType: 'text', content: 'Future calendar event for migration QA.' },
          isAllDay: false,
        },
      },
      {
        label: 'weekly recurring event',
        body: {
          subject: 'QA E2E - Weekly Recurring Event',
          start:   { dateTime: recurStart.toISOString(), timeZone: 'UTC' },
          end:     { dateTime: recurEnd.toISOString(),   timeZone: 'UTC' },
          body:    { contentType: 'text', content: 'Recurring weekly event for migration QA.' },
          isAllDay: false,
          recurrence: {
            pattern: { type: 'weekly', interval: 1, daysOfWeek: [['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][recurStart.getDay()]] },
            range:   { type: 'numbered', startDate: recurStart.toISOString().split('T')[0], numberOfOccurrences: 4 },
          },
        },
      },
      {
        label: 'multi-day event',
        body: {
          subject:  'QA E2E - Multi-Day Calendar Event',
          start:    { dateTime: multiDayStart.toISOString(), timeZone: 'UTC' },
          end:      { dateTime: multiDayEnd.toISOString(),   timeZone: 'UTC' },
          body:     { contentType: 'text', content: 'Multi-day event spanning 2 days — migration QA.' },
          isAllDay: true,
        },
      },
      {
        label: 'event with attendees',
        body: {
          subject:   'QA E2E - Meeting With Attendees',
          start:     { dateTime: futureStart.toISOString(), timeZone: 'UTC' },
          end:       { dateTime: futureEnd.toISOString(),   timeZone: 'UTC' },
          body:      { contentType: 'text', content: 'Meeting event with external attendees — migration QA.' },
          isAllDay:  false,
          attendees: [
            { emailAddress: { address: externalSender.address, name: externalSender.name }, type: 'required' },
          ],
        },
      },
      {
        label: 'event with description',
        body: {
          subject:  'QA E2E - Event With Long Description',
          start:    { dateTime: recurStart.toISOString(), timeZone: 'UTC' },
          end:      { dateTime: recurEnd.toISOString(),   timeZone: 'UTC' },
          body:     { contentType: 'html', content: '<html><body><h2>Meeting Agenda</h2><ol><li>Introduction</li><li>Status update</li><li>Action items</li><li>Q&A</li></ol><p>Please come prepared with your weekly status.</p></body></html>' },
          isAllDay: false,
        },
      },
      {
        label: 'non-UTC timezone event (America/New_York)',
        body: {
          subject:  'QA E2E - Eastern Time Zone Event (America/New_York)',
          start:    { dateTime: futureStart.toISOString().replace('Z', ''), timeZone: 'Eastern Standard Time' },
          end:      { dateTime: futureEnd.toISOString().replace('Z', ''),   timeZone: 'Eastern Standard Time' },
          body:     { contentType: 'text', content: 'Non-UTC timezone event using Eastern Standard Time (America/New_York equivalent) — validates timezone preservation across Outlook→Gmail migration.' },
          isAllDay: false,
        },
      },
    ];

    for (const ev of calEvents) {
      try {
        await outlookClient.createCalendarEvent(userEmail, defaultCalId, ev.body);
        summary.calendarEventsCreated++;
        log.info(`✓ Calendar event (${ev.label}) created`);
      } catch (err) {
        log.warn(`Calendar event (${ev.label}) failed: ${err.message}`);
        summary.errors.push(`Calendar event "${ev.label}": ${err.message}`);
      }
    }

    // ── D-Cal-Exception. Recurring event with a single modified occurrence ────
    // Creates a weekly recurring series, then patches the second occurrence to
    // have a different subject/body — tests exception handling in migration.
    log.info('E2E (DELTA): creating recurring event with exception…');
    try {
      const exStart = new Date(now); exStart.setDate(exStart.getDate() + 30);
      const exEnd   = new Date(exStart); exEnd.setHours(exEnd.getHours() + 1);
      const baseSeries = await outlookClient.createCalendarEvent(userEmail, defaultCalId, {
        subject:  'QA E2E - Recurring Weekly (Exception Series)',
        start:    { dateTime: exStart.toISOString(), timeZone: 'UTC' },
        end:      { dateTime: exEnd.toISOString(),   timeZone: 'UTC' },
        body:     { contentType: 'text', content: 'Base recurring series — second occurrence will be modified as an exception for migration QA.' },
        isAllDay: false,
        recurrence: {
          pattern: { type: 'weekly', interval: 1, daysOfWeek: [['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][exStart.getDay()]] },
          range:   { type: 'numbered', startDate: exStart.toISOString().split('T')[0], numberOfOccurrences: 4 },
        },
      });
      summary.calendarEventsCreated++;
      log.info(`✓ D-Cal-Exception: base recurring series created (id=${baseSeries?.id})`);

      if (baseSeries?.id) {
        try {
          const instances = await outlookClient.getCalendarEventInstances(userEmail, baseSeries.id, 5);
          const secondInstance = instances[1] || instances[0];
          if (secondInstance?.id) {
            await outlookClient.updateCalendarEvent(userEmail, secondInstance.id, {
              subject: 'QA E2E - Recurring Weekly (Exception: 2nd Occurrence Modified)',
              body:    { contentType: 'text', content: 'Exception occurrence: this instance of the recurring series was individually modified — tests recurring event exception migration from Outlook to Gmail.' },
            });
            log.info(`✓ D-Cal-Exception: second occurrence patched (id=${secondInstance.id})`);
          } else {
            log.warn('D-Cal-Exception: no second instance found — exception patch skipped');
          }
        } catch (err) {
          log.warn(`D-Cal-Exception patch failed (non-fatal): ${err.message}`);
          summary.errors.push(`D-Cal-Exception patch: ${err.message}`);
        }
      }
    } catch (err) {
      log.warn(`D-Cal-Exception series creation failed: ${err.message}`);
      summary.errors.push(`D-Cal-Exception: ${err.message}`);
    }

    // ── D-Cal-Attach. Calendar event with file attachment ───────────────────
    log.info('E2E (DELTA): creating calendar event with attachment…');
    try {
      const attachEventBody = {
        subject: 'QA E2E - Calendar Event With Attachment',
        body: { contentType: 'HTML', content: '<html><body><p>QA calendar event with file attachment — tests calendar attachment migration.</p></body></html>' },
        start: { dateTime: futureStart.toISOString(), timeZone: 'UTC' },
        end:   { dateTime: futureEnd.toISOString(),   timeZone: 'UTC' },
        attendees: [],
        isReminderOn: false,
      };
      const createdEvent = await outlookClient.createCalendarEvent(userEmail, defaultCalId, attachEventBody);
      if (createdEvent?.id) {
        await outlookClient.addEventAttachment(userEmail, createdEvent.id, {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'qa-calendar-doc.txt',
          contentType: 'text/plain',
          contentBytes: Buffer.from('QA calendar attachment — migration test document content.').toString('base64'),
        });
        summary.calendarEventsCreated++;
        log.info('✓ Calendar event with attachment created');
      }
    } catch (err) {
      log.warn(`Calendar event with attachment failed: ${err.message}`);
      summary.errors.push(`Calendar attachment event: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-Cal-Single. Single instance (non-recurring) calendar event ─────────
    // Explicitly creates one non-recurring event with the canonical subject used
    // in inscope feature verification. The future-event in D-Cal is also a single
    // instance, but this entry carries a distinctive subject for precise matching.
    log.info('E2E (DELTA): creating single instance calendar event…');
    try {
      const siStart = new Date(futureStart); siStart.setDate(siStart.getDate() + 5);
      const siEnd   = new Date(siStart); siEnd.setHours(siEnd.getHours() + 1);
      await outlookClient.createCalendarEvent(userEmail, defaultCalId, {
        subject:  'QA E2E - Single Instance Calendar Event',
        start:    { dateTime: siStart.toISOString(), timeZone: 'UTC' },
        end:      { dateTime: siEnd.toISOString(),   timeZone: 'UTC' },
        body:     { contentType: 'text', content: 'Single non-recurring calendar event — inscope feature: single instance calendar. Tests that a one-time event migrates with correct start/end times, no recurrence pattern.' },
        isAllDay: false,
      });
      summary.calendarEventsCreated++;
      log.info('✓ Single instance calendar event created');
    } catch (err) {
      log.warn(`Single instance calendar event failed: ${err.message}`);
      summary.errors.push(`Single instance calendar event: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-Cal-Delegate. Calendar delegate / permissions event ───────────────
    // Microsoft Graph does not expose a direct "add calendar delegate" endpoint
    // in the delegated-permission flow available to test agents. Instead we create
    // a clearly labelled calendar event and log a note so QA can manually verify
    // delegate configuration if needed. The event subject matches the inscope
    // feature name for automated result correlation.
    log.info('E2E (DELTA): creating calendar delegate event marker…');
    try {
      const delStart = new Date(futureStart); delStart.setDate(delStart.getDate() + 6);
      const delEnd   = new Date(delStart); delEnd.setHours(delEnd.getHours() + 1);
      await outlookClient.createCalendarEvent(userEmail, defaultCalId, {
        subject:  'QA E2E - Calendar Delegate Event Test',
        start:    { dateTime: delStart.toISOString(), timeZone: 'UTC' },
        end:      { dateTime: delEnd.toISOString(),   timeZone: 'UTC' },
        body: {
          contentType: 'HTML',
          content: '<html><body>'
            + '<p><strong>Calendar Delegate / Permissions Test</strong></p>'
            + '<p>This event is a marker for the Calendar Permissions / Delegates inscope feature.</p>'
            + '<p>To fully exercise this scenario, a delegate must be manually configured in '
            + 'Outlook (File → Account Settings → Delegate Access) and granted editor permissions '
            + 'on the calendar. The migration tooling should then preserve delegate access after migration.</p>'
            + '<p>Migration QA — inscope feature: Calendar Permissions / Delegates.</p>'
            + '</body></html>',
        },
        isAllDay: false,
      });
      summary.calendarEventsCreated++;
      log.info('✓ Calendar delegate event marker created (note: manual delegate config required for full scenario)');
    } catch (err) {
      log.warn(`Calendar delegate event failed: ${err.message}`);
      summary.errors.push(`Calendar delegate event: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-Cal-Busy. Calendar event with showAs='busy' ───────────────────────
    // Explicitly sets the showAs property to 'busy' to verify that free/busy
    // status is preserved during migration (inscope: Busy Status in Calendar event).
    log.info('E2E (DELTA): creating calendar event with busy showAs…');
    try {
      const busyStart = new Date(futureStart); busyStart.setDate(busyStart.getDate() + 8);
      const busyEnd   = new Date(busyStart); busyEnd.setHours(busyEnd.getHours() + 1);
      await outlookClient.createCalendarEvent(userEmail, defaultCalId, {
        subject:  'QA E2E - Busy Status Calendar Event',
        start:    { dateTime: busyStart.toISOString(), timeZone: 'UTC' },
        end:      { dateTime: busyEnd.toISOString(),   timeZone: 'UTC' },
        body:     { contentType: 'text', content: 'Calendar event with showAs=busy — inscope feature: Busy Status in Calendar event. Tests that the free/busy indicator migrates correctly.' },
        isAllDay: false,
        showAs:   'busy',
      });
      summary.calendarEventsCreated++;
      log.info('✓ Busy status calendar event created (showAs=busy)');
    } catch (err) {
      log.warn(`Busy status calendar event failed: ${err.message}`);
      summary.errors.push(`Busy status calendar event: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-SharedCal. Shared calendar (DELTA only) ───────────────────────────
    log.info('E2E (DELTA): creating shared calendar…');
    try {
      const sharedCal = await outlookClient.getOrCreateCalendar(userEmail, 'QA Shared Calendar');
      const shareWith = context.destinationEmail || context.sourceEmail;
      await outlookClient.shareCalendar(userEmail, sharedCal.id, shareWith, 'write');
      const sharedEvStart = new Date(futureStart); sharedEvStart.setDate(sharedEvStart.getDate() + 3);
      const sharedEvEnd   = new Date(sharedEvStart); sharedEvEnd.setHours(sharedEvEnd.getHours() + 1);
      await outlookClient.createCalendarEvent(userEmail, sharedCal.id, {
        subject:  'QA E2E - Shared Calendar Event',
        start:    { dateTime: sharedEvStart.toISOString(), timeZone: 'UTC' },
        end:      { dateTime: sharedEvEnd.toISOString(),   timeZone: 'UTC' },
        body:     { contentType: 'text', content: 'Event in shared calendar for migration QA. Tests that shared calendar events migrate with proper attendee data.' },
        isAllDay: false,
        attendees: [
          { emailAddress: { address: shareWith, name: shareWith.split('@')[0] }, type: 'required' },
          { emailAddress: { address: 'qa-attendee-1@qatestagent.com', name: 'QA Attendee One' }, type: 'required' },
          { emailAddress: { address: 'qa-attendee-2@qatestagent.com', name: 'QA Attendee Two' }, type: 'optional' },
        ],
      });
      summary.calendarEventsCreated++;
      log.info(`✓ Shared calendar "${sharedCal.name}" created and shared with ${shareWith} (3 attendees)`);
    } catch (err) {
      log.warn(`Shared calendar failed: ${err.message}`);
      summary.errors.push(`Shared calendar: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D-Contacts. Contacts (DELTA only) ──────────────────────────────────
    log.info('E2E (DELTA): creating contacts…');
    const sampleContacts = [
      {
        displayName: 'QA Contact Alpha',
        givenName: 'QA', surname: 'Alpha',
        emailAddresses: [{ address: 'qa.alpha@external-test.com', name: 'QA Alpha' }],
        businessPhones: ['+1-555-0001'],
        companyName: 'QA Test Corp',
      },
      {
        displayName: 'QA Contact Beta',
        givenName: 'QA', surname: 'Beta',
        emailAddresses: [{ address: 'qa.beta@external-test.com', name: 'QA Beta' }],
        businessPhones: ['+1-555-0002'],
        companyName: 'QA Test Corp',
      },
      {
        displayName: 'QA Contact Gamma',
        givenName: 'QA', surname: 'Gamma',
        emailAddresses: [{ address: 'qa.gamma@external-test.com', name: 'QA Gamma' }],
        businessPhones: ['+1-555-0003'],
        companyName: 'QA Test Corp',
      },
      {
        displayName: 'QA Contact Delta',
        givenName: 'QA', surname: 'Delta',
        emailAddresses: [{ address: 'qa.delta@external-test.com', name: 'QA Delta' }],
        businessPhones: ['+1-555-0004', '+1-555-0044'],
        companyName: 'QA Test Corp',
        jobTitle: 'QA Engineer',
        birthday: '1990-06-15T00:00:00Z',
      },
      {
        displayName: 'QA Contact Epsilon',
        givenName: 'QA', surname: 'Epsilon',
        emailAddresses: [{ address: 'qa.epsilon@external-test.com', name: 'QA Epsilon' }],
        homeAddress: { street: '123 QA Street', city: 'Test City', state: 'CA', postalCode: '90001', countryOrRegion: 'United States' },
        personalNotes: 'QA contact with home address — migration test.',
        companyName: 'QA External Corp',
      },
      {
        displayName: 'QA Contact Zeta',
        givenName: 'QA', surname: 'Zeta',
        emailAddresses: [
          { address: 'qa.zeta.work@external-test.com', name: 'QA Zeta Work' },
          { address: 'qa.zeta.home@personal.com', name: 'QA Zeta Personal' },
        ],
        businessPhones: ['+44-20-1234-5678'],
        companyName: 'QA International Ltd',
        jobTitle: 'Senior QA Manager',
        personalNotes: 'Contact with multiple email addresses and international phone.',
      },
    ];

    for (const contact of sampleContacts) {
      try {
        await outlookClient.createContact(userEmail, contact);
        summary.contactsCreated++;
        log.info(`✓ Contact "${contact.displayName}" created`);
      } catch (err) {
        log.warn(`Contact "${contact.displayName}" failed: ${err.message}`);
        summary.errors.push(`Contact "${contact.displayName}": ${err.message}`);
      }
    }

    // Set a test photo on QA Contact Alpha to validate contact photo migration
    // Tiny 1×1 transparent PNG (base64) used as a recognizable test photo marker
    const QA_PHOTO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    for (const contact of sampleContacts) {
      if (contact.displayName !== 'QA Contact Alpha') continue;
      try {
        // Re-fetch created contacts to get their IDs, then set photo on Alpha
        const token = await require('../../clients/outlookClient').getAccessToken
          ? null : null; // just use the client method below
        const created = await outlookClient.getContactsWithDetails(userEmail);
        const alpha = (created.contacts || []).find(c => c.displayName === 'QA Contact Alpha');
        if (alpha?.id) {
          await outlookClient.setContactPhoto(userEmail, alpha.id, QA_PHOTO_PNG);
          log.info('✓ Contact photo set on QA Contact Alpha');
        }
      } catch (err) {
        log.warn(`Contact photo set failed: ${err.message}`);
      }
      break;
    }

    // ── D-Contacts-Partial. Contact with empty/missing optional fields ─────────
    // Inscope feature: "Contacts with any one empty field" — verifies that partial
    // contacts (only name + email, all other fields absent) migrate without errors
    // or data corruption. Some migration tools skip contacts where optional fields
    // are null; this seeds one such contact to expose that failure mode.
    log.info('E2E (DELTA): creating partial contact (name + email only)…');
    try {
      await outlookClient.createContact(userEmail, {
        displayName: 'QA Contact Partial (Name+Email Only)',
        givenName:   'QA',
        surname:     'Partial',
        emailAddresses: [{ address: 'qa.partial@external-test.com', name: 'QA Partial' }],
        // businessPhones, companyName, jobTitle, homeAddress, personalNotes intentionally absent
        // — tests that a contact with only name+email migrates correctly
      });
      summary.contactsCreated++;
      log.info('✓ Partial contact (name + email only) created');
    } catch (err) {
      log.warn(`Partial contact failed: ${err.message}`);
      summary.errors.push(`Partial contact: ${err.message}`);
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D1. Delta Inbox — new emails picked up by delta migration ───────────
    log.info('E2E (DELTA): creating delta inbox emails…');
    const deltaInboxCases = [
      { subject: 'QA Delta - New Plain Email', body: 'New email added after initial migration — delta should pick this up.' },
      { subject: 'QA Delta - New HTML Email', body: '<html><body><p>New <b>HTML email</b> added post-migration.</p></body></html>', html: true },
      { subject: 'QA Delta - New Email With Attachment', body: 'New email with attachment in delta run.', attachment: { name: 'delta-file.txt', content: 'Delta attachment content' } },
      { subject: 'QA Delta - New Flagged Email', body: 'Newly added flagged email for delta migration.', flagged: true },
      { subject: 'QA Delta - New Read Email', body: 'Newly added read email for delta migration.', read: true },
      { subject: 'QA Delta - New Email With CC', body: 'New delta email with CC recipient.', cc: true },
      { subject: 'QA Delta - New Unread Email', body: 'Newly added unread email — delta migration QA.' },
      { subject: 'QA Delta - Re: New Thread Reply', body: 'New reply in delta run — thread continuation test.' },
    ];

    for (const tc of deltaInboxCases) {
      try {
        const msg = {
          subject:      tc.subject,
          body:         { contentType: tc.html ? 'html' : 'text', content: tc.body },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead:       tc.read || false,
          isDraft:      false,
        };
        if (tc.flagged) msg.flag = { flagStatus: 'flagged' };
        if (tc.cc) msg.ccRecipients = [{ emailAddress: { address: secondSender.address, name: secondSender.name } }];
        if (tc.attachment) {
          msg.attachments = [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: tc.attachment.name,
            contentType: 'text/plain',
            contentBytes: Buffer.from(tc.attachment.content).toString('base64'),
          }];
        }
        await outlookClient.createMessageInFolder(userEmail, 'inbox', msg);
        summary.messagesCreated++;
        log.info(`✓ Delta inbox: "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta inbox "${tc.subject}" failed: ${err.message}`);
        summary.errors.push(`Delta inbox: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D2. Delta Sent — new sent emails ────────────────────────────────────
    log.info('E2E (DELTA): creating delta sent emails…');
    const deltaSentCases = [
      { subject: 'QA Delta - New Sent Email', body: 'New sent email in delta run.' },
      { subject: 'QA Delta - New Sent HTML', body: '<html><body><p>New sent <i>HTML</i> email in delta run.</p></body></html>', html: true },
      { subject: 'QA Delta - New Sent With Attachment', body: 'New sent email with attachment.', attachment: { name: 'delta-sent.txt', content: 'Delta sent attachment' } },
      { subject: 'QA Delta - Re: New Sent Reply', body: 'New reply sent in delta run.' },
      { subject: 'QA Delta - New Sent With CC', body: 'New sent email with CC in delta run.', cc: true },
    ];

    for (const tc of deltaSentCases) {
      try {
        const msg = {
          subject:      tc.subject,
          body:         { contentType: tc.html ? 'html' : 'text', content: tc.body },
          from:         { emailAddress: { address: userEmail, name: userEmail.split('@')[0] } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: true, isDraft: false,
        };
        if (tc.cc) msg.ccRecipients = [{ emailAddress: { address: externalSender.address, name: externalSender.name } }];
        if (tc.attachment) {
          msg.attachments = [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: tc.attachment.name,
            contentType: 'text/plain',
            contentBytes: Buffer.from(tc.attachment.content).toString('base64'),
          }];
        }
        await outlookClient.createMessageInFolder(userEmail, 'sentitems', msg);
        summary.messagesCreated++;
        log.info(`✓ Delta sent: "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta sent "${tc.subject}" failed: ${err.message}`);
        summary.errors.push(`Delta sent: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D3. Delta Draft — new / updated drafts ──────────────────────────────
    log.info('E2E (DELTA): creating delta draft emails…');
    const deltaDraftCases = [
      { subject: 'QA Delta - New Draft Email', body: 'New draft added in delta run.' },
      { subject: 'QA Delta - New Draft With BCC', body: 'New draft with BCC in delta run.', bcc: true },
      { subject: 'QA Delta - New Draft HTML', body: '<html><body><p>Updated draft with <u>underline</u> text.</p></body></html>', html: true },
      { subject: 'QA Delta - New Draft With Attachment', body: 'New draft with attachment.', attachment: { name: 'delta-draft.txt', content: 'Delta draft attachment' } },
    ];

    for (const tc of deltaDraftCases) {
      try {
        const msg = {
          subject:      tc.subject,
          body:         { contentType: tc.html ? 'html' : 'text', content: tc.body },
          from:         { emailAddress: { address: userEmail } },
          toRecipients: [{ emailAddress: externalSender }],
          isRead: false, isDraft: true,
        };
        if (tc.bcc) msg.bccRecipients = [{ emailAddress: { address: thirdSender.address } }];
        if (tc.attachment) {
          msg.attachments = [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: tc.attachment.name,
            contentType: 'text/plain',
            contentBytes: Buffer.from(tc.attachment.content).toString('base64'),
          }];
        }
        await outlookClient.createMessageInFolder(userEmail, 'drafts', msg);
        summary.messagesCreated++;
        log.info(`✓ Delta draft: "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta draft "${tc.subject}" failed: ${err.message}`);
        summary.errors.push(`Delta draft: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D4. Delta Junk — new spam emails ────────────────────────────────────
    log.info('E2E (DELTA): creating delta junk emails…');
    const deltaJunkCases = [
      { subject: 'QA Delta - New Junk Email', body: 'New junk email in delta run.' },
      { subject: 'QA Delta - New Junk Large Content', body: 'Large junk content: ' + 'Lorem ipsum dolor sit amet. '.repeat(100) },
      { subject: 'QA Delta - New Junk HTML', body: '<html><body><p style="color:red">New spam HTML in delta.</p></body></html>', html: true },
      { subject: 'QA Delta - New Junk With Attachment', body: 'New junk with attachment.', attachment: { name: 'delta-junk.txt', content: 'Delta junk attachment' } },
    ];

    for (const tc of deltaJunkCases) {
      try {
        const msg = {
          subject:      tc.subject,
          body:         { contentType: tc.html ? 'html' : 'text', content: tc.body },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        };
        if (tc.attachment) {
          msg.attachments = [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: tc.attachment.name,
            contentType: 'text/plain',
            contentBytes: Buffer.from(tc.attachment.content).toString('base64'),
          }];
        }
        await outlookClient.createMessageInFolder(userEmail, 'junkemail', msg);
        summary.messagesCreated++;
        log.info(`✓ Delta junk: "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta junk "${tc.subject}" failed: ${err.message}`);
        summary.errors.push(`Delta junk: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D5. Delta Deleted — newly deleted emails ────────────────────────────
    log.info('E2E (DELTA): creating delta deleted emails…');
    const deltaDeletedCases = [
      { subject: 'QA Delta - New Deleted Email', body: 'New deleted email in delta run.' },
      { subject: 'QA Delta - New Deleted Formatted', body: '<html><body><p><b>Formatted</b> deleted email in delta.</p></body></html>', html: true },
      { subject: 'QA Delta - New Deleted Forwarded', body: 'FW: Newly deleted forwarded email — delta QA.' },
      { subject: 'QA Delta - New Deleted With Attachment', body: 'Deleted email with attachment in delta.', attachment: { name: 'delta-deleted.txt', content: 'Delta deleted attachment' } },
    ];

    for (const tc of deltaDeletedCases) {
      try {
        const msg = {
          subject:      tc.subject,
          body:         { contentType: tc.html ? 'html' : 'text', content: tc.body },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: true, isDraft: false,
        };
        if (tc.attachment) {
          msg.attachments = [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: tc.attachment.name,
            contentType: 'text/plain',
            contentBytes: Buffer.from(tc.attachment.content).toString('base64'),
          }];
        }
        await outlookClient.createMessageInFolder(userEmail, 'deleteditems', msg);
        summary.messagesCreated++;
        log.info(`✓ Delta deleted: "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta deleted "${tc.subject}" failed: ${err.message}`);
        summary.errors.push(`Delta deleted: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D6. Delta Folders — emails in new / existing custom folders ─────────
    log.info('E2E (DELTA): creating delta custom folder emails…');
    const deltaFolderCases = [
      { folderName: 'QA-Migration-Folder', subject: 'QA Delta - New Email In Existing Folder', body: 'New email added to existing custom folder in delta run.' },
      { folderName: 'QA-Delta-New-Folder', subject: 'QA Delta - New Custom Folder Email 1', body: 'Email in brand-new custom folder created during delta.' },
      { folderName: 'QA-Delta-New-Folder', subject: 'QA Delta - New Custom Folder Email 2', body: 'Second email in new delta custom folder.' },
      { folderName: 'QA-Work-Projects',    subject: 'QA Delta - New Email In Work Projects', body: 'New email added to Work Projects folder in delta run.' },
    ];

    const deltaFolderCache = {};
    for (const tc of deltaFolderCases) {
      try {
        if (!deltaFolderCache[tc.folderName]) {
          deltaFolderCache[tc.folderName] = await outlookClient.getOrCreateMailFolder(userEmail, tc.folderName);
        }
        await outlookClient.createMessageInFolder(userEmail, deltaFolderCache[tc.folderName], {
          subject:      tc.subject,
          body:         { contentType: 'text', content: tc.body },
          from:         { emailAddress: externalSender },
          toRecipients: [{ emailAddress: { address: userEmail } }],
          isRead: false, isDraft: false,
        });
        summary.messagesCreated++;
        log.info(`✓ Delta folder "${tc.folderName}": "${tc.subject}"`);
      } catch (err) {
        log.warn(`Delta folder "${tc.folderName}" email failed: ${err.message}`);
        summary.errors.push(`Delta folder ${tc.folderName}: ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D7. Delta Calendar — new events ────────────────────────────────────
    log.info('E2E (DELTA): creating delta calendar events…');
    const deltaCalStart1 = new Date(now); deltaCalStart1.setDate(deltaCalStart1.getDate() + 30);
    const deltaCalEnd1   = new Date(deltaCalStart1); deltaCalEnd1.setHours(deltaCalEnd1.getHours() + 1);
    const deltaCalStart2 = new Date(now); deltaCalStart2.setDate(deltaCalStart2.getDate() + 35);
    const deltaCalEnd2   = new Date(deltaCalStart2); deltaCalEnd2.setHours(deltaCalEnd2.getHours() + 2);

    const deltaCalEvents = [
      {
        label: 'delta new future event',
        body: {
          subject:  'QA Delta - New Future Event',
          start:    { dateTime: deltaCalStart1.toISOString(), timeZone: 'UTC' },
          end:      { dateTime: deltaCalEnd1.toISOString(),   timeZone: 'UTC' },
          body:     { contentType: 'text', content: 'New calendar event added in delta run.' },
          isAllDay: false,
        },
      },
      {
        label: 'delta new recurring event',
        body: {
          subject:    'QA Delta - New Daily Recurring Event',
          start:      { dateTime: deltaCalStart2.toISOString(), timeZone: 'UTC' },
          end:        { dateTime: deltaCalEnd2.toISOString(),   timeZone: 'UTC' },
          body:       { contentType: 'text', content: 'New daily recurring event added in delta run.' },
          isAllDay:   false,
          recurrence: {
            pattern: { type: 'daily', interval: 1 },
            range:   { type: 'numbered', startDate: deltaCalStart2.toISOString().split('T')[0], numberOfOccurrences: 3 },
          },
        },
      },
    ];

    for (const ev of deltaCalEvents) {
      try {
        await outlookClient.createCalendarEvent(userEmail, null, ev.body);
        summary.calendarEventsCreated++;
        log.info(`✓ Delta calendar event (${ev.label}) created`);
      } catch (err) {
        log.warn(`Delta calendar event (${ev.label}) failed: ${err.message}`);
        summary.errors.push(`Delta calendar "${ev.label}": ${err.message}`);
      }
    }

    if (context.executionId && executionService.isCancelled(context.executionId)) return;

    // ── D8. Delta Contacts — new contacts ───────────────────────────────────
    log.info('E2E (DELTA): creating delta contacts…');
    const deltaContacts = [
      {
        displayName: 'QA Delta Contact Eta',
        givenName: 'QA', surname: 'Eta',
        emailAddresses: [{ address: 'qa.eta@external-test.com', name: 'QA Eta' }],
        businessPhones: ['+1-555-0007'],
        companyName: 'QA Delta Corp',
      },
      {
        displayName: 'QA Delta Contact Theta',
        givenName: 'QA', surname: 'Theta',
        emailAddresses: [{ address: 'qa.theta@external-test.com', name: 'QA Theta' }],
        businessPhones: ['+1-555-0008'],
        companyName: 'QA Delta Corp',
        jobTitle: 'Delta QA Tester',
      },
      {
        displayName: 'QA Delta Contact Iota',
        givenName: 'QA', surname: 'Iota',
        emailAddresses: [{ address: 'qa.iota@external-test.com', name: 'QA Iota' }],
        personalNotes: 'Contact added during delta migration run.',
        companyName: 'QA Delta Corp',
      },
    ];

    for (const contact of deltaContacts) {
      try {
        await outlookClient.createContact(userEmail, contact);
        summary.contactsCreated++;
        log.info(`✓ Delta contact "${contact.displayName}" created`);
      } catch (err) {
        log.warn(`Delta contact "${contact.displayName}" failed: ${err.message}`);
        summary.errors.push(`Delta contact "${contact.displayName}": ${err.message}`);
      }
    }

    } // end if (context.migrationType === 'DELTA')
  }
}

module.exports = OutlookTestDataAgent;
