const path = require('path');
const fs = require('fs');
const { BaseAgent } = require('../core/BaseAgent');
const gmailClient = require('../../clients/gmailClient');
const calendarClient = require('../../clients/calendarClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');
const { generateTestFileBuffer } = require('../../utils/testFileGenerator');
const XLSX = require('xlsx');
const {
  tryLoadMailCasesFromExcel,
  tryLoadDraftCasesFromExcel,
  defaultGmailTestCasesXlsxPath,
} = require('../../utils/gmailTestCasesExcel');

/**
 * Per-domain static user lists — checked BEFORE Admin SDK / GOOGLE_ACCOUNTS.
 * internal: same-domain users (used for To/CC/BCC and inbound mail)
 * external: cross-domain senders (added to inbound senders for variety)
 */
// External cross-domain users for Gmail-source test cases (G→O and G→G). These are the ONLY external
// correspondents/senders used — real accounts so migrated From/To/Cc resolve to genuine addresses.
const EXTERNAL_TEST_USERS = ['mia@cloudfuze.com', 'sophia@cloudfuze.com'];

const DOMAIN_KNOWN_USERS = {
  'migrationn.com': {
    internal: ['alex@migrationn.com', 'ben@migrationn.com', 'dan@migrationn.com', 'ron@migrationn.com', 'blue1@migrationn.com', 'blue2@migrationn.com', 'blue3@migrationn.com'],
    external: [...EXTERNAL_TEST_USERS],
  },
  'storefuze.com': {
    internal: ['collins-gd@storefuze.com', 'davidgd@storefuze.com', 'rebel-gd@storefuze.com', 'hyma-gd@storefuze.com', 'guru-gd@storefuze.com', 'dev1-gd@storefuze.com', 'dev2-gd@storefuze.com', 'presales1-gd@storefuze.com', 'presales2-gd@storefuze.com'],
    external: [...EXTERNAL_TEST_USERS],
  },
};

/**
 * Generic fallback when no domain map and no Admin SDK / GOOGLE_ACCOUNTS users are available.
 * Only the two external test users (mia, sophia) are used — cycled to cover callers that index up
 * to [4] (the Archive-section inbound seeds) so no slot is ever undefined.
 */
const FALLBACK_EXTERNAL_CORRESPONDENTS = Array.from(
  { length: 5 },
  (_, i) => EXTERNAL_TEST_USERS[i % EXTERNAL_TEST_USERS.length]
);

const SAMPLE_ATTACHMENT_DATA = Buffer.from('Sample attachment content for QA testing').toString('base64');
const SAMPLE_ATTACHMENT_SECOND = Buffer.from('Second file for multi-attachment E2E').toString('base64');
/** Minimal valid PDF (556 bytes) — correct xref offsets, renders one page with visible text
 *  ("QA Migration Test PDF"). A real document so opened attachments are not blank. */
const SAMPLE_MINIMAL_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+ID4+ID4+ID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggNTMgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAxMDAgNzAwIFRkIChRQSBNaWdyYXRpb24gVGVzdCBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDUKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjkwIDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNSAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMzkzCiUlRU9GCg==';
/** ~1KB — small binary attachment tier */
const SAMPLE_1K_B64 = Buffer.alloc(1024, 77).toString('base64');
/** ~64KB — mid-size attachment (PDF “large” smoke) */
const SAMPLE_LARGE_B64 = Buffer.alloc(64 * 1024, 120).toString('base64');
/** ~100KB */
const SAMPLE_100K_B64 = Buffer.alloc(100 * 1024, 55).toString('base64');
/** ~512KB — large attachment stress without approaching provider limits (raw binary; use only for .bin) */
const SAMPLE_512K_B64 = Buffer.alloc(512 * 1024, 99).toString('base64');
/** ~512KB VALID PDF with real page text — for .pdf medium tiers (opens with content, not a blank blob). */
const SAMPLE_512K_PDF_B64 = generateTestFileBuffer('qa-attachment-512kb.pdf', 0.5).toString('base64');
/** Minimal valid JPEG (1×1 px) — image/jpeg attachment migration */
const SAMPLE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k=';
/** Minimal PNG (1×1 transparent) — image/png attachment migration */
const SAMPLE_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Minimal STORE zip (qa-archive.txt) — application/zip attachment migration */
const SAMPLE_ZIP_B64 =
  'UEsDBBQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAcWEtYXJjaGl2ZS50eHRtaWdyYXRpb24tcWEgemlwIHNhbXBsZVBLAQIUABQAAAAAAIFSl1iua2JjFwAAABcAAAAOAAAAAAAAAAAAAAAAAAAAAABxYS1hcmNoaXZlLnR4dFBLBQYAAAAAAQA8AAAAQwAAAAAAAAA=';
/** ~2MB — max practical tier for seeded mail (expect slower upload) */
const SAMPLE_2M_B64 = Buffer.alloc(2 * 1024 * 1024, 210).toString('base64');
/** Minimal CSV (user-mapping report style) — text/csv attachment migration */
const SAMPLE_CSV_B64 = Buffer.from(
  'Name,Email,Department\nDan,dan@cloudfuze.us,Admin\nAlice,alice@example.com,User\nBob,bob@example.com,Engineer'
).toString('base64');
/** Minimal iCalendar (.ics) — one VEVENT for ICS attachment migration */
const SAMPLE_ICS_B64 = Buffer.from(
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CloudFuze QA//EN\r\nBEGIN:VEVENT\r\nUID:qa-ics-event-001@cloudfuze.qa\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260601T090000Z\r\nDTEND:20260601T100000Z\r\nSUMMARY:QA Test Meeting\r\nDESCRIPTION:ICS attachment seeded by QA agent for migration testing.\r\nORGANIZER:mailto:qa-agent@cloudfuze.qa\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
).toString('base64');
/** Minimal valid DOCX (~1 KB) — proper ZIP/OpenXML container, opens in Word with real content
 *  (not a filler-byte stub, so migrated .docx attachments are openable). */
const SAMPLE_DOCX_B64 = 'UEsDBBQAAAAIAIkMtFx5bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiUDxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXrmTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZJr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAAAAgAiQy0XJv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNFDIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcMplwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAIAIkMtFzp+cGTewAAAJsAAAAcAAAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc1XMQQ4CIQyF4auQ7h3QhTEGmJ0HMHqAZqYCkSmEEqO3l6UuX/68z87vLasXNUmFHewnA4p4KWvi4OB+u+xOoKQjr5gLk4MPCczeXiljHxeJqYoaBouD2Hs9ay1LpA1lKpV4lEdpG/YxW9AVlycG0gdjjrr9GuCt/kP9F1BLAwQUAAAACACJDLRc0tYU0fMAAACWAQAAEQAAAHdvcmQvZG9jdW1lbnQueG1sbZDdSsQwEIVfJeTepuuFSGl3kRXvRIUK3o5p2gaaTMiMrfv2JvEPViGcTDLMN2emPby7RawmkkXfyV1VS2G8xsH6qZPP/d3FtRTE4AdY0JtOngzJw77dmgH1mzOeRQJ4aragOzkzh0Yp0rNxQJWzOiLhyJVGp3AcrTZqwzioy3pXlyhE1IYodTuCX4HkN+4PDIPxKTdidMDpGaczgFsStr5SDqyX2eErDqd8hywxC++fbsS9nSJwGlf0hljcfs3RqpzPGouG89J+tiTSAcGl7uH4IoAZ9FzWkIwJ94NeYbFDCat/wWQ0P0ZVPj59qt+V7j8AUEsBAhQAFAAAAAgAiQy0XHluM9foAAAArQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAACACJDLRcm/036q0AAAApAQAACwAAAAAAAAAAAAAAgAEZAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAACACJDLRc6fnBk3sAAACbAAAAHAAAAAAAAAAAAAAAgAHvAQAAd29yZC9fcmVscy9kb2N1bWVudC54bWwucmVsc1BLAQIUABQAAAAIAIkMtFzS1hTR8wAAAJYBAAARAAAAAAAAAAAAAACAAaQCAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAABAAEAAMBAADGAwAAAAA=';
// ── Minimal store-only ZIP builder (for building a real, openable XLSX) ──────────
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function _crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function _zipStore(files) {
  const local = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const data = Buffer.from(f.data, 'utf8'); const crc = _crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}
/** Minimal valid XLSX — real OpenXML spreadsheet with visible cell text (opens in Excel). */
const SAMPLE_XLSX_B64 = _zipStore([
  { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
  { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
  { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="QA" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
  { name: 'xl/worksheets/sheet1.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>CloudFuze QA Migration Test</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>This spreadsheet was seeded by the QA agent for attachment migration testing.</t></is></c></row></sheetData></worksheet>' },
]).toString('base64');

function requestedTrashOrSpam(labelIds) {
  return (labelIds || []).some((id) => ['TRASH', 'SPAM'].includes(String(id).toUpperCase()));
}

// Valid Gmail built-in CATEGORY_ system labels — anything else with this prefix is a custom label name.
const GMAIL_VALID_CATEGORY_LABELS = new Set([
  'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
]);

// Per-email cache: avoid re-listing labels on every email during the same seed run.
const _labelCache = new Map(); // sourceEmail → Map<labelNameLower, labelId>

async function resolveCustomLabelIds(sourceEmail, labelIds) {
  if (!Array.isArray(labelIds) || labelIds.length === 0) return labelIds;

  const customOnes = labelIds.filter(
    (id) => String(id).toUpperCase().startsWith('CATEGORY_') && !GMAIL_VALID_CATEGORY_LABELS.has(String(id).toUpperCase())
  );
  if (customOnes.length === 0) return labelIds;

  // Build/refresh the label name→id cache for this account
  if (!_labelCache.has(sourceEmail)) {
    const existing = await gmailClient.listLabels(sourceEmail, 'me');
    const map = new Map();
    for (const l of existing) map.set(l.name.toLowerCase(), l.id);
    _labelCache.set(sourceEmail, map);
  }
  const cache = _labelCache.get(sourceEmail);

  const resolved = [...labelIds];
  for (let i = 0; i < resolved.length; i++) {
    const raw = String(resolved[i]);
    if (!raw.toUpperCase().startsWith('CATEGORY_') || GMAIL_VALID_CATEGORY_LABELS.has(raw.toUpperCase())) continue;

    // e.g. CATEGORY_PROJECTX → ProjectX
    const name = raw.replace(/^CATEGORY_/i, '').charAt(0).toUpperCase() + raw.replace(/^CATEGORY_/i, '').slice(1).toLowerCase();
    const key = name.toLowerCase();

    if (!cache.has(key)) {
      try {
        const res = await gmailClient.createLabel(sourceEmail, 'me', name);
        const newId = res.data?.id;
        if (newId) cache.set(key, newId);
      } catch (createErr) {
        // Label may already exist from a previous run — re-list and retry
        const fresh = await gmailClient.listLabels(sourceEmail, 'me');
        const freshMap = new Map(fresh.map((l) => [l.name.toLowerCase(), l.id]));
        _labelCache.set(sourceEmail, freshMap);
        if (!freshMap.has(key)) throw new Error(`Could not create Gmail label "${name}": ${createErr.message}`);
      }
    }

    resolved[i] = _labelCache.get(sourceEmail).get(key);
  }
  return resolved;
}

/**
 * users.messages.insert often adds INBOX alongside SENT for outbound mail. Legacy seeds sometimes
 * requested INBOX explicitly (wrong for “sent” scenarios). Always remove INBOX for outbound so mail
 * stays out of Inbox; inbound keeps INBOX and drops stray SENT.
 */
async function reconcileInsertedMessageLabels(sourceEmail, emailDef, messageId, log) {
  if (!messageId) return;

  if (requestedTrashOrSpam(emailDef.labelIds)) {
    // A Spam/Trash test mail must live ONLY in Spam/Trash. users.messages.insert auto-adds SENT
    // (and sometimes INBOX) for outbound mail, so e.g. "Spam folder" became SENT|SPAM — which the
    // validator then flagged as a folder mismatch vs the destination (SPAM only). Strip the
    // auto-added SENT/INBOX unless the def explicitly asked for SENT.
    const wantsSent = (emailDef.labelIds || []).some((l) => String(l).toUpperCase() === 'SENT');
    if (!wantsSent) {
      try {
        await gmailClient.modifyMessageLabels(sourceEmail, 'me', messageId, [], ['SENT', 'INBOX']);
      } catch (e) {
        // "Invalid label: SENT" means it was never attached — safe to ignore
        if (!e.message?.includes('Invalid label')) {
          log.warn(`Gmail seed: could not strip SENT/INBOX from spam/trash message ${messageId}: ${e.message}`);
        }
      }
    }
    return;
  }

  if (emailDef.mailDirection === 'incoming') {
    // Gmail's messages.insert auto-adds INBOX. Only keep it when the test EXPLICITLY asked for INBOX
    // (a true Inbox mail). A mail filed under a custom label (or otherwise not requesting INBOX) must
    // NOT also sit in Inbox — in Gmail a "filed"/archived mail has INBOX removed and lives under its
    // label + All Mail only. Keeping the auto-added INBOX made labeled mails appear in Inbox too and,
    // on migration, land in the wrong folder / get duplicated.
    const wantsInbox = (emailDef.labelIds || []).some((l) => String(l).toUpperCase() === 'INBOX');
    const toRemove = wantsInbox ? ['SENT'] : ['SENT', 'INBOX'];
    try {
      await gmailClient.modifyMessageLabels(sourceEmail, 'me', messageId, [], toRemove);
    } catch (e) {
      // "Invalid label: SENT/INBOX" means it was never attached — safe to ignore
      if (!e.message?.includes('Invalid label')) {
        log.warn(`Gmail seed: could not reconcile labels (${toRemove.join(',')}) on inbound message ${messageId}: ${e.message}`);
      }
    }
    return;
  }

  try {
    await gmailClient.modifyMessageLabels(sourceEmail, 'me', messageId, [], ['INBOX']);
  } catch (e) {
    log.warn(`Gmail seed: could not remove INBOX from outbound message ${messageId}: ${e.message}`);
  }
}

/**
 * Apply 20% unread / 80% read distribution across an email definitions array.
 * Every 5th eligible email gets UNREAD added. Skips emails that are already
 * explicitly UNREAD, or that live in SENT/SPAM/TRASH/DRAFT (read-state not applicable).
 * Mutates + returns the same array.
 */
function applyReadUnreadDistribution(emails, unreadPercent = 20) {
  if (!Array.isArray(emails)) return emails;
  const step = Math.round(100 / unreadPercent); // 5 for 20%
  const skipLabels = new Set(['SENT', 'SPAM', 'TRASH', 'DRAFT']);
  let eligibleIdx = 0;
  for (const def of emails) {
    if (!def || typeof def !== 'object') continue;
    const labels = def.labelIds || [];
    // Skip if already marked UNREAD, or only in non-inbox system folders
    const inSkipFolder = labels.some(l => skipLabels.has(String(l).toUpperCase()));
    const alreadyUnread = labels.includes('UNREAD');
    if (inSkipFolder || alreadyUnread) continue;
    eligibleIdx++;
    // Mark every Nth eligible email as UNREAD (deterministic, not random)
    if (eligibleIdx % step === 0) {
      def.labelIds = [...labels, 'UNREAD'];
    }
  }
  return emails;
}

/**
 * Prefix each subject with a per-run running counter so reports / Gmail show
 * "QA E2E 1 - ...", "QA E2E 2 - ...", etc. Matches any "QA <TestType> -" header (or bare
 * "QA -") and inserts the index before the separator; non-matching subjects get the
 * "[N] " prefix so numbering is still visible. Mutates + returns the same array.
 *
 * Kept intentionally separate from the insertion loop so the same function can renumber
 * mail and drafts independently (both start from 1).
 */
function applyRunningSubjectNumbering(emails) {
  if (!Array.isArray(emails)) return emails;
  let n = 0;
  const pad2 = (x) => String(x).padStart(2, '0');
  for (const def of emails) {
    if (!def || typeof def !== 'object') continue;
    n += 1;
    // keepSubjectRaw: true preserves the subject as-is (e.g. intentionally empty subject tests)
    if (def.keepSubjectRaw) continue;
    const original = String(def.subject || '').trim();
    if (!original) {
      def.subject = `QA [${pad2(n)}]`;
      continue;
    }
    const m = original.match(/^(QA(?:\s+[A-Za-z0-9]+)?)\s*-\s*(.*)$/i);
    if (m) {
      def.subject = `${m[1]} ${n} - ${m[2]}`.trim();
    } else {
      def.subject = `[${pad2(n)}] ${original}`;
    }
  }
  return emails;
}

/**
 * Inbound seeds: insert-only messages into the Gmail source's Inbox that LOOK like they
 * arrived from other tenant users. Nothing is actually sent — we build raw MIME and call
 * users.messages.insert against the source mailbox only; no data is written to the
 * correspondent's mailbox.
 *
 * @param {string} prefix subject prefix (e.g. "QA Smoke")
 * @param {string[] | string} sendersOrCorrespondent list of sender addresses to rotate through
 *                                                    (preferred); a single string still works.
 * @param {string} ccEmail alternate address for Cc on the "with Cc" seed (full mode).
 * @param {{ mode?: 'minimal'|'standard'|'full' }} opts
 * @returns {object[]} email definitions ready for insertion (each carries `inboundFrom`).
 */
function buildInboundInboxSeeds(prefix, sendersOrCorrespondent, ccEmail, { mode = 'standard' } = {}) {
  const sendersRaw = Array.isArray(sendersOrCorrespondent)
    ? sendersOrCorrespondent
    : [sendersOrCorrespondent];
  const senders = sendersRaw
    .map((s) => String(s || '').trim())
    .filter((s) => s.includes('@'));
  if (senders.length === 0) return [];

  // Deterministic rotation so the same run always produces the same sender per seed.
  const pickSender = (idx) => senders[idx % senders.length];

  const plain = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(0),
    subject: `${prefix} - Inbound plain`,
    textBody:
      'Inbound: tenant user → migration source mailbox (expect Inbox). Used for received-mail migration QA. Insert-only — no mail left in sender mailbox.',
    labelIds: ['INBOX'],
  };
  const html = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(1),
    subject: `${prefix} - Inbound HTML`,
    htmlBody:
      '<html><body><h2>Inbound HTML</h2><p>Received by source mailbox.</p><ul><li>List item</li></ul></body></html>',
    textBody: 'Inbound HTML fallback',
    labelIds: ['INBOX'],
  };
  const attach = {
    mailDirection: 'incoming',
    inboundFrom: pickSender(2),
    subject: `${prefix} - Inbound attachment`,
    textBody: 'Inbound with attachment.',
    labelIds: ['INBOX'],
    attachments: [{ filename: 'inbound-att.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
  };

  if (mode === 'minimal') {
    return [plain];
  }

  let rows = [plain, html, attach];

  if (mode === 'standard' || mode === 'full') {
    rows.push(
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(3),
        subject: `${prefix} - Inbound text format (multiline bullets)`,
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(4),
        subject: `${prefix} - Inbound PNG image attachment`,
        textBody: 'Please find the screenshot attached.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'inbound-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      }
    );
  }

  if (mode === 'full') {
    const ccNorm = ccEmail ? String(ccEmail).trim().toLowerCase() : '';
    const ccDistinctFromSenders = ccNorm && !senders.some((s) => s.toLowerCase() === ccNorm);
    if (ccDistinctFromSenders) {
      rows.push({
        mailDirection: 'incoming',
        inboundFrom: pickSender(5),
        subject: `${prefix} - Inbound with Cc`,
        textBody: 'Inbound with Cc for mapping validation.',
        labelIds: ['INBOX'],
        cc: ccEmail,
      });
    }
    rows.push(
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(6),
        subject: `${prefix} - Inbound unread`,
        textBody: 'Inbound unread read-state check.',
        labelIds: ['INBOX', 'UNREAD'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(7),
        subject: `${prefix} - Inbound Starred`,
        textBody: 'Inbound + Starred.',
        labelIds: ['INBOX', 'STARRED'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(8),
        subject: `${prefix} - Inbound emoji subject 📬`,
        textBody: 'Unicode inbound subject line.',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(9),
        subject: `${prefix} - Inbound rich HTML`,
        htmlBody: '<html><body><h2>Inbound Rich HTML</h2><p><strong>Bold</strong> <em>italic</em> <u>underline</u> <s>strikethrough</s></p><ul><li>Bullet one</li><li>Bullet two</li></ul><ol><li>Ordered one</li><li>Ordered two</li></ol><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Quoted block</blockquote><p><span style="color:#cc0000">Red text</span> <span style="background-color:#ffd600">Highlighted</span></p></body></html>',
        textBody: 'Inbound rich HTML fallback.',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(10),
        subject: `${prefix} - Inbound PDF attachment`,
        textBody: 'Inbound with PDF attachment.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'inbound-document.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(11),
        subject: `${prefix} - Inbound two files (PNG and CSV)`,
        textBody: 'Sending 2 attachments',
        labelIds: ['INBOX'],
        attachments: [
          { filename: 'inbound-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'inbound-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(12),
        subject: `${prefix} - Inbound Important`,
        textBody: 'Inbound + Important label migration check.',
        labelIds: ['INBOX', 'IMPORTANT'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(13),
        subject: `${prefix} - Inbound long body`,
        textBody: 'This is a longer inbound email body for migration testing.\n\nParagraph two with more content to verify that multi-paragraph plain text emails are migrated correctly from Gmail to Outlook, preserving the full body without truncation.\n\nParagraph three — final section.\n\nRegards,\nQA Bot',
        labelIds: ['INBOX'],
      },
      {
        mailDirection: 'incoming',
        inboundFrom: pickSender(14),
        subject: `${prefix} - Inbound HTML with link and table`,
        htmlBody: '<html><body><p>Please review the migration report:</p><p><a href="https://example.com/report">View Report</a></p><table border="1" cellpadding="4"><tr><th>User</th><th>Status</th></tr><tr><td>alice@example.com</td><td>Migrated</td></tr><tr><td>bob@example.com</td><td>Pending</td></tr></table></body></html>',
        textBody: 'Please review the migration report. View: https://example.com/report',
        labelIds: ['INBOX'],
      }
    );
  }

  return rows;
}

/** Minimal labels for SANITY runs */
const SANITY_LABEL_NAMES = ['QA-TestLabel', 'QA-Important'];
/**
 * Full E2E: create custom Gmail labels at source, then seed mail (Sent + user labels and label-only).
 */
const E2E_LABEL_NAMES = [
  'QA-TestLabel',
  'QA-TestLabel/Nested-Child',
  'QA-TestLabel/Nested-Child/Deep-Level',
  'QA-Important',
  'QA-Archive',
  'QA-E2E-Staging',
  'QA-E2E-Compliance',
  /** Gmail→Outlook PDF scenarios: label→folder mapping */
  'ProjectX',
  'AutoLabel',
  /** Inscope: Migrate Orphaned Labels */
  'QA-Orphaned-Label',
  /** Inscope (G→G): Shared Mailbox */
  'QA-Shared-Mailbox',
  /** Inscope: Filters/Rules — dedicated labels for filter-routed emails (skip Inbox) */
  'QA-Filter-From-Sender',
  'QA-Filter-Subject-Keyword',
  'QA-Filter-Has-Attachment',
  'QA-Filter-Combined',
  'QA-Filter-Size',
  /** Custom folder equivalents — mirrors OutlookTestDataAgent §11, §20, §25, §31 */
  'QA-Migration-Folder',
  'QA-Work-Projects',
  'QA-Client-Emails',
  'QA-Sent-To-Custom',
  /** Multi-recipient thread chain spanning Inbox + 2 custom labels (§117) */
  'QA-Thread-Label-1',
  'QA-Thread-Label-2',
  /** Sub-level folder structure — mirrors OutlookTestDataAgent §23 (Q1–Q10) */
  'QA-SubLevel-Root',
  'QA-SubLevel-Root/QA-Sub-Q1',
  'QA-SubLevel-Root/QA-Sub-Q2',
  'QA-SubLevel-Root/QA-Sub-Q3',
  'QA-SubLevel-Root/QA-Sub-Q4',
  'QA-SubLevel-Root/QA-Sub-Q5',
  'QA-SubLevel-Root/QA-Sub-Q6',
  'QA-SubLevel-Root/QA-Sub-Q7',
  'QA-SubLevel-Root/QA-Sub-Q8',
  'QA-SubLevel-Root/QA-Sub-Q9',
  'QA-SubLevel-Root/QA-Sub-Q10',
  /** Parent + child folder — mirrors OutlookTestDataAgent §32 */
  'QA-Parent-With-Sub',
  'QA-Parent-With-Sub/QA-Child-Under-Parent',
  /** Deep nested chain — mirrors OutlookTestDataAgent §22 (15 levels) */
  'QA-Deep-L1',
  'QA-Deep-L1/QA-Deep-L2',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10/QA-Deep-L11',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10/QA-Deep-L11/QA-Deep-L12',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10/QA-Deep-L11/QA-Deep-L12/QA-Deep-L13',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10/QA-Deep-L11/QA-Deep-L12/QA-Deep-L13/QA-Deep-L14',
  'QA-Deep-L1/QA-Deep-L2/QA-Deep-L3/QA-Deep-L4/QA-Deep-L5/QA-Deep-L6/QA-Deep-L7/QA-Deep-L8/QA-Deep-L9/QA-Deep-L10/QA-Deep-L11/QA-Deep-L12/QA-Deep-L13/QA-Deep-L14/QA-Deep-L15',
];

function loadCustomTestCases(testType, log) {
  try {
    const filePath = path.resolve(__dirname, '../../../data/custom-test-cases.json');
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const cases = (data[testType.toLowerCase()] || []);
    if (cases.length > 0) log.info(`Loading ${cases.length} custom test case(s) for ${testType}`);
    return cases.map((tc) => ({
      subject: tc.subject,
      textBody: tc.textBody,
      htmlBody: tc.htmlBody,
      mailDirection: tc.mailDirection === 'incoming' ? 'incoming' : undefined,
      labelIds: tc.labelIds || (tc.mailDirection === 'incoming' ? ['INBOX'] : ['SENT']),
      attachments: tc.hasAttachment
        ? [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }]
        : undefined,
    }));
  } catch (e) {
    log.warn(`Failed to load custom test cases: ${e.message}`);
    return [];
  }
}
const SAMPLE_INLINE_IMAGE = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
).toString('base64');

/*
 * Test type determines how much test data gets created:
 *
 * SMOKE  — 1 plain text email only (quick connectivity check)
 * SANITY — plain text + HTML + attachment + labels + drafts (core features)
 * E2E    — full coverage: default + category + custom labels, Cc from GOOGLE_ACCOUNTS, emoji/Unicode,
 *          optional Snoozed label if present (Gmail API cannot set snooze time). Gmail UI “reactions”
 *          are not exposed for creation via public Gmail API — emoji-rich bodies cover Unicode instead.
 *          E2E adds: Bcc-only / Cc+Bcc / multi-attachment, HTML links+tables, unread bit, Personal category.
 *          E2E creates user labels (QA-E2E-*, ProjectX, AutoLabel, etc.) and seeds mail per label,
 *          including label-only. Outgoing: SENT + reconcile; inbound: INBOX (correspondent → source) so
 *          the source user receives mail. Additional seeds align with Gmail→Outlook PDF smoke/migration
 *          docs: compose To/Cc/Bcc + formatting + signature block, unicode, PDF + large binary attachments,
 *          multi-label on one message, conversation thread (In-Reply chain).
 *
 * Mail To: / calendar attendees: pickCorrespondentEmail() — another address from GOOGLE_ACCOUNTS
 * when available (else source). Messages are still inserted into the migration source mailbox.
 *
 * Calendar (E2E + Include Calendar): data is always created in the *source* user's Google account
 * (OAuth via GOOGLE_ACCOUNTS token for that user, with gmailClient fallback). One *secondary*
 * calendar "QA Secondary Calendar" is created; three events go on *primary*, one on that secondary.
 * FULL vs DELTA does not change this seeding — CloudFuze delta still migrates new/changed items.
 *
 * Mail + draft scenarios: primary source is backend/data/gmail-test-cases.xlsx (sheets Mail, Drafts).
 * Override path with GMAIL_TEST_CASES_XLSX. If the file or matching rows are missing, built-in
 * definitions in this module are used. Regenerate defaults: npm run generate-gmail-test-xlsx
 */

class GmailTestDataAgent extends BaseAgent {
  constructor() {
    super('GmailTestDataAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });
    const sourceEmail = context.sourceEmail;
    const testType = context.testType || 'E2E';
    const summary = {
      testType,
      emailsCreated: 0,
      labelsCreated: 0,
      draftsCreated: 0,
      eventsCreated: 0,
      contactsCreated: 0,
      correspondentEmail: null,
    };

    // For tenant 3 (migrationn.com DWD), fetch domain users via Admin SDK
    // and use them as correspondent/cc/bcc/inbound senders instead of GOOGLE_ACCOUNTS.
    const sourceDomain = (sourceEmail || '').split('@')[1]?.toLowerCase() || '';
    const isTenant2 = Array.isArray(env.GOOGLE_TENANT_2_DOMAINS) && env.GOOGLE_TENANT_2_DOMAINS.includes(sourceDomain);
    const isTenant3 = Array.isArray(env.GOOGLE_TENANT_3_DOMAINS) && env.GOOGLE_TENANT_3_DOMAINS.includes(sourceDomain);
    // The single service account serves every Google domain via DWD, so any source
    // can list its domain users dynamically (Admin SDK) — no per-domain .env config needed.
    const isDWDTenant = !!env.GOOGLE_SERVICE_ACCOUNT_KEY || (isTenant2 && gmailClient.hasServiceAccount('2')) || isTenant3;

    let correspondentEmail, ccEmail, bccEmail, effectiveInboundSenders;

    // Static domain map takes priority over Admin SDK and GOOGLE_ACCOUNTS env config.
    const staticMap = DOMAIN_KNOWN_USERS[sourceDomain];
    if (staticMap) {
      const internal = staticMap.internal.filter((e) => e.toLowerCase() !== sourceEmail.toLowerCase());
      const external = staticMap.external || [];
      const all = [...internal, ...external];
      correspondentEmail      = all[0]  || FALLBACK_EXTERNAL_CORRESPONDENTS[0];
      ccEmail                 = all[1]  || FALLBACK_EXTERNAL_CORRESPONDENTS[1];
      bccEmail                = all[2]  || FALLBACK_EXTERNAL_CORRESPONDENTS[2];
      effectiveInboundSenders = all.length > 0 ? all : FALLBACK_EXTERNAL_CORRESPONDENTS;
      log.info(`Using static domain map for ${sourceDomain}: ${internal.length} internal + ${external.length} external users`);
    } else if (isDWDTenant) {
      const tenantLabel = isTenant2 ? 'Tenant 2' : 'Tenant 3';
      const knownUsersEnvKey = isTenant2 ? 'GOOGLE_TENANT_2_KNOWN_USERS' : 'GOOGLE_TENANT_3_KNOWN_USERS';
      let domainUserEmails = [];

      // Prefer explicitly configured known users over Admin SDK.
      const knownUsers = (env[knownUsersEnvKey] || [])
        .filter((e) => e.toLowerCase() !== sourceEmail.toLowerCase());

      if (knownUsers.length > 0) {
        domainUserEmails = knownUsers;
        log.info(`${tenantLabel}: using ${domainUserEmails.length} configured known user(s): [${domainUserEmails.join(', ')}]`);
      } else {
        try {
          const domainUsers = await gmailClient.listDomainUsers(sourceEmail);
          domainUserEmails = domainUsers
            .map((u) => u.email)
            .filter((e) => e.toLowerCase() !== sourceEmail.toLowerCase());
          log.info(`${tenantLabel}: fetched ${domainUserEmails.length} domain user(s) via Admin SDK: [${domainUserEmails.join(', ')}]`);
        } catch (e) {
          log.warn(`${tenantLabel}: failed to fetch domain users via Admin SDK: ${e.message}`);
        }
      }

      if (domainUserEmails.length === 0) {
        log.warn(`${tenantLabel}: no domain users found — using external fallback correspondents so mail is not self-addressed`);
        correspondentEmail      = FALLBACK_EXTERNAL_CORRESPONDENTS[0];
        ccEmail                 = FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = FALLBACK_EXTERNAL_CORRESPONDENTS;
      } else {
        correspondentEmail      = domainUserEmails[0];
        ccEmail                 = domainUserEmails[1] || FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = domainUserEmails[2] || FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = domainUserEmails;
      }
    } else {
      correspondentEmail = env.pickCorrespondentEmail(sourceEmail);
      ccEmail = env.pickCcEmail(sourceEmail, correspondentEmail);
      bccEmail = env.pickBccEmail(sourceEmail, correspondentEmail, ccEmail);
      const inboundSenders = env.buildGoogleInboundSenders(sourceEmail);
      effectiveInboundSenders = inboundSenders.length > 0 ? inboundSenders : [correspondentEmail];

      // If GOOGLE_ACCOUNTS has only one entry the pickers fall back to sourceEmail.
      // Replace with external fallback addresses so mail is never self-addressed.
      if (correspondentEmail.toLowerCase() === sourceEmail.toLowerCase()) {
        log.warn('No distinct correspondent in GOOGLE_ACCOUNTS — using external fallback addresses so mail is not self-addressed');
        correspondentEmail      = FALLBACK_EXTERNAL_CORRESPONDENTS[0];
        ccEmail                 = FALLBACK_EXTERNAL_CORRESPONDENTS[1];
        bccEmail                = FALLBACK_EXTERNAL_CORRESPONDENTS[2];
        effectiveInboundSenders = FALLBACK_EXTERNAL_CORRESPONDENTS;
      }
    }

    summary.correspondentEmail = correspondentEmail;
    summary.ccEmail = ccEmail;
    summary.bccEmail = bccEmail;
    summary.inboundSenders = effectiveInboundSenders;
    log.info(
      `Creating test data in Gmail for: ${sourceEmail} [${testType}] — To: ${correspondentEmail}, Cc: ${ccEmail}, Bcc: ${bccEmail}, Inbound senders: [${effectiveInboundSenders.join(', ')}] (${isDWDTenant ? 'Admin SDK DWD' : 'GOOGLE_ACCOUNTS'})`
    );

    if (context.includeMail) {
      if (testType !== 'SMOKE') {
        await this._createLabels(sourceEmail, testType, summary, log);
      }
      if (!executionService.isCancelled(context.executionId)) {
        await this._createEmails(sourceEmail, correspondentEmail, ccEmail, bccEmail, effectiveInboundSenders, testType, summary, log, context.executionId);
      }
      if (!executionService.isCancelled(context.executionId) && testType !== 'SMOKE') {
        await this._createDrafts(sourceEmail, correspondentEmail, ccEmail, testType, summary, log, context.executionId);
      }
      // 5. Filters/rules (G→O and G→G inscope) — seed Gmail filter rules for E2E only.
      if (!executionService.isCancelled(context.executionId) && testType === 'E2E') {
        await this._seedGmailFilters(sourceEmail, log, { inboundSenders: effectiveInboundSenders });
      }
      // 1. All Mail (Gmail Only) — no explicit seeding needed. Every message in any label
      //    automatically appears in All Mail. Validation agent will confirm this during post-migration checks.
      if (testType === 'E2E') {
        log.info('All Mail (inscope): No explicit seed required — all seeded messages are automatically present in Gmail All Mail. Validation will confirm All Mail count matches migrated items.');
      }
      // 10. Group Mail Migration (G→O and G→G inscope) — Google Workspace group migration.
      //     Group mailboxes are tenant-level resources; seeding requires admin provisioning outside
      //     this agent. Log the expectation so the run report includes the scenario.
      if (testType === 'E2E') {
        log.info('Group Mail Migration (inscope): Google Workspace group mailboxes are provisioned at tenant level. Validate that any groups configured in the tenant are listed in CloudFuze and included in the migration scope.');
      }
    }

    if (!executionService.isCancelled(context.executionId) && context.includeCalendar && testType === 'E2E') {
      await this._createCalendarEvents(sourceEmail, correspondentEmail, summary, log);
      // 11. Sharing calendar with group of people (G→O inscope) — calendar ACL sharing.
      //     The Google Calendar API supports calendarList ACL sharing (calendar.acl.insert).
      //     calendarClient does not currently expose an ACL method. The QA Secondary Calendar
      //     created above is owned by sourceEmail; sharing it with a group would require
      //     calendar.acl.insert with type:"group" and value:<group email>.
      //     Log this gap so it is visible in the run report.
      log.info('Calendar sharing with group (inscope): calendarClient does not yet expose calendar.acl.insert. The QA Secondary Calendar event has been seeded with individual attendees. To validate group calendar sharing, add an ACL rule via the Google Calendar API (type:"group") for a Google Workspace group in this tenant.');
    }

    if (!executionService.isCancelled(context.executionId) && context.includeContacts) {
      await this._seedContacts(sourceEmail, summary, log);
      // 7. Contact labels (G→O inscope) — create a contact group and assign a contact to it.
      if (testType === 'E2E') {
        await this._seedContactGroup(sourceEmail, log);
      }
    }

    log.info(`Test data generation complete [${testType}]: ${JSON.stringify(summary)}`);
    return summary;
  }

  async _createLabels(sourceEmail, testType, summary, log) {
    const labels = testType === 'SANITY' ? SANITY_LABEL_NAMES : E2E_LABEL_NAMES;

    const intervalMs = env.FOLDER_CREATE_INTERVAL_MS;
    for (const labelName of labels) {
      try {
        await gmailClient.createLabel(sourceEmail, 'me', labelName);
        summary.labelsCreated++;
        log.info(`Created label: ${labelName}`);
        // Space out nested/sub-label creation so sibling folders get distinct, increasing
        // creation timestamps — the destination then preserves their order (matches manual
        // creation with natural gaps). Only nested labels (with '/') need the interval.
        if (intervalMs > 0 && labelName.includes('/')) {
          log.info(`Waiting ${Math.round(intervalMs / 1000)}s before next nested label (preserve folder order)…`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (err) {
        if (err.message?.includes('already exists') || err.message?.includes('conflicts')) {
          log.info(`Label already exists: ${labelName}`);
        } else {
          log.error(`Failed to create label ${labelName}: ${err.message}`);
        }
      }
    }
  }

  async _loadE2ELabelContext(sourceEmail, log) {
    let labels = [];
    try {
      labels = await gmailClient.listLabels(sourceEmail, 'me');
    } catch (e) {
      log.error(`E2E: listLabels failed: ${e.message}`);
    }
    const names = [...E2E_LABEL_NAMES];
    const qaIds = {};
    for (const n of names) {
      const hit = labels.find((l) => l.name === n);
      if (hit) qaIds[n] = hit.id;
      else log.warn(`E2E: label "${n}" not found — run label creation or check name`);
    }
    const snoozeHit = labels.find((l) => /snooz/i.test(l.name || ''));
    if (snoozeHit) log.info(`E2E: Snooze label "${snoozeHit.name}" (${snoozeHit.id})`);
    const snoozeId = snoozeHit?.id || null;
    if (!snoozeId) log.info('E2E: No "Snoozed" label in mailbox — skipping snooze sample (label only exists after manual snooze in Gmail UI)');
    return { qaIds, snoozeId };
  }

  _e2eEmailDefinitions(qaIds, snoozeId, ccEmail, bccEmail, sourceEmail, correspondentEmail) {
    const reactionNote =
      '<p style="color:#666"><i>Gmail UI reactions are not set via API; emoji exercises Unicode in migration.</i></p>';
    const base = [
      {
        subject: 'QA E2E - Plain Text Email',
        textBody: 'E2E test: plain text email for full migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - HTML Email',
        htmlBody: `<html><body>
          <h1>HTML Test Email</h1>
          <p>This is an <strong>HTML email</strong> generated by the QA agent.</p>
          <ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>
        </body></html>`,
        textBody: 'HTML Test Email - fallback plain text',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Email with Attachment',
        textBody: 'E2E test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Email with Inline Image',
        htmlBody: `<html><body>
          <h1>Inline Image Test 👍</h1>
          ${reactionNote}
          <p>Emoji in body: ❤️ 😀 🎉</p>
          <p>Below is an inline image:</p>
          <img src="cid:inline-image-001" alt="test image" />
        </body></html>`,
        textBody: 'Inline + emoji fallback',
        inlineImages: [{ contentId: 'inline-image-001', mimeType: 'image/gif', data: SAMPLE_INLINE_IMAGE }],
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Cc from GOOGLE_ACCOUNTS',
        textBody: 'E2E: Cc line uses a distinct address from GOOGLE_ACCOUNTS (see env picker).',
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      {
        subject: 'QA E2E - Emoji subject 📧✅',
        textBody: 'Plain body emoji: 👍 ❤️ 😀 🎉 📎',
        htmlBody: `<html><body>${reactionNote}<h2>Unicode 🚀</h2><p>✅ ❌ ⭐ 📧</p></body></html>`,
        labelIds: ['SENT'],
        cc: ccEmail,
      },
      { subject: 'QA E2E - Starred', textBody: 'E2E: Sent + Starred.', labelIds: ['SENT', 'STARRED'] },
      { subject: 'QA E2E - Important', textBody: 'E2E: Sent + Important.', labelIds: ['SENT', 'IMPORTANT'] },
      {
        subject: 'QA E2E - Category Social',
        textBody: 'E2E: Primary + Social category.',
        labelIds: ['SENT', 'CATEGORY_SOCIAL'],
      },
      {
        subject: 'QA E2E - Category Forums',
        textBody: 'E2E: Primary + Forums category.',
        labelIds: ['SENT', 'CATEGORY_FORUMS'],
      },
      {
        subject: 'QA E2E - Category Promotions',
        textBody: 'E2E: Primary + Promotions category.',
        labelIds: ['SENT', 'CATEGORY_PROMOTIONS'],
      },
      {
        subject: 'QA E2E - Category Updates',
        textBody: 'E2E: Primary + Updates category.',
        labelIds: ['SENT', 'CATEGORY_UPDATES'],
      },
      { subject: 'QA E2E - Spam folder', textBody: 'E2E: message in Spam.', labelIds: ['SPAM'] },
      { subject: 'QA E2E - Trash folder', textBody: 'E2E: message in Trash.', labelIds: ['TRASH'] },
      {
        subject: 'QA E2E - Sent Email',
        textBody: 'E2E test: sent email for migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Bcc from GOOGLE_ACCOUNTS',
        textBody: 'E2E: Bcc line only (distinct GOOGLE_ACCOUNTS user, not sender); validates Bcc migration + mapping.',
        labelIds: ['SENT'],
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - Cc and Bcc combined',
        textBody: 'E2E: From/To/Cc/Bcc all distinct GOOGLE_ACCOUNTS users (no self-Bcc).',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - Two attachments',
        textBody: 'E2E: multiple file attachments for name/size validation.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-first.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA },
          { filename: 'qa-second.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_SECOND },
        ],
      },
      {
        subject: 'QA E2E - Text with single file (PNG image)',
        textBody: 'Please find the screenshot attached.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      },
      {
        subject: 'QA E2E - Text with two files (PNG and CSV)',
        textBody: 'Sending 2 attachments',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
      },
      {
        subject: 'QA E2E - Text with file (JPEG and PDF)',
        textBody: 'Please review the attached image and PDF document.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 },
          { filename: 'qa-onepage.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 },
        ],
      },
      {
        subject: 'QA E2E - Text with CSV attachment',
        textBody: 'Please find the user mapping report attached.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 }],
      },
      {
        subject: 'QA E2E - HTML links and table',
        textBody: 'Plain fallback for HTML with links.',
        htmlBody: `<html><body>
          <p><a href="https://example.com/migration-qa">Example link</a> and <a href="mailto:test@example.com">mailto</a></p>
          <table border="1" cellpadding="4"><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Subject "Re:" special chars <tag> | pipe',
        textBody: 'E2E: subject line encoding and punctuation survive migration.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Unread',
        textBody: 'E2E: Sent + UNREAD for read-state migration checks.',
        labelIds: ['SENT', 'UNREAD'],
      },
      {
        subject: 'QA E2E - Category Personal',
        textBody: 'E2E: Primary + Personal category.',
        labelIds: ['SENT', 'CATEGORY_PERSONAL'],
      },
      {
        subject: 'QA E2E - PDF Smoke 3.2 Compose To Cc Bcc format signature',
        htmlBody: `<html><body>
          <p><strong>Bold</strong>, <em>italic</em>, <u>underline</u></p>
          <ul><li>Bullet one</li><li>Bullet two</li></ul>
          <p style="color:#234">Formatted body (Smoke PDF 3.2).</p>
          <hr/>
          <p>—<br/>Migration QA Bot<br/>Signature block</p>
        </body></html>`,
        textBody: 'Compose PDF scenario: formatting + signature plain fallback.',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: bccEmail,
      },
      {
        subject: 'QA E2E - PDF 3.14 Email formatting',
        htmlBody:
          '<html><body><p><b>Bold</b> <i>Italic</i> <u>Underline</u></p><ol><li>Ordered</li><li>List</li></ol></body></html>',
        textBody: 'Formatting fallback',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - PDF 3.30 Unicode multilingual مرحبا 中文 한글 🌍',
        textBody: 'rus: привет • téxt',
        htmlBody: '<html><body><p>العربية • 日本語 • 🎉</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - PDF 3.4 Attachments txt and pdf',
        textBody: 'GMAIL TO OUTLOOK PDF: multiple attachment types.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-notes.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA },
          { filename: 'qa-onepage.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 },
        ],
      },
      {
        subject: 'QA E2E - PDF 3.4 Large attachment 64KB',
        textBody: 'Large blob for size/integrity checks.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-large.bin', mimeType: 'application/octet-stream', data: SAMPLE_LARGE_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~1KB binary',
        textBody: 'Single ~1KB attachment (small tier).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-1k.bin', mimeType: 'application/octet-stream', data: SAMPLE_1K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~100KB binary',
        textBody: 'Single ~100KB attachment (medium-large tier).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-100k.bin', mimeType: 'application/octet-stream', data: SAMPLE_100K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~512KB binary',
        textBody: 'Single ~512KB attachment (large tier for Gmail→Outlook).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-512k.bin', mimeType: 'application/octet-stream', data: SAMPLE_512K_B64 }],
      },
      {
        subject: 'QA E2E - Attachment JPEG image',
        textBody: 'Minimal JPEG file as normal attachment (not inline).',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 }],
      },
      {
        subject: 'QA E2E - Attachment PNG image',
        textBody: 'Minimal PNG file as normal attachment.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ZIP archive',
        textBody: 'Minimal ZIP with one text entry.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-sample.zip', mimeType: 'application/zip', data: SAMPLE_ZIP_B64 }],
      },
      {
        subject: 'QA E2E - Attachment ~2MB binary',
        textBody: 'Large ~2MB blob for attachment size ceiling checks.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-2mb.bin', mimeType: 'application/octet-stream', data: SAMPLE_2M_B64 }],
      },
      {
        subject: 'QA E2E - Attachments JPEG PNG ZIP together',
        textBody: 'Three common file types in one message.',
        labelIds: ['SENT'],
        attachments: [
          { filename: 'qa-sample.jpg', mimeType: 'image/jpeg', data: SAMPLE_JPEG_B64 },
          { filename: 'qa-sample.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-sample.zip', mimeType: 'application/zip', data: SAMPLE_ZIP_B64 },
        ],
      },
      {
        subject: 'QA E2E - Rich HTML strike blockquote pre code color font',
        textBody: 'Fallback: strike, quote, code.',
        htmlBody: `<html><body>
          <p><s>Strikethrough</s> <sub>sub</sub> <sup>sup</sup></p>
          <blockquote cite="https://example.com">Quoted migration block.</blockquote>
          <pre>line1\nline2\t<code>inline code</code></pre>
          <p><span style="color:#b35900;font-size:16px">Colored span</span>
          <span style="background:#eee;padding:2px">Highlighted</span></p>
          <p><font face="Georgia,serif">Georgia body text</font></p>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Many hyperlinks http https mailto query',
        textBody: 'Plain fallback for link-heavy HTML.',
        htmlBody: `<html><body>
          <p><a href="https://example.com/migration-qa/path">HTTPS path</a></p>
          <p><a href="http://example.org/http-only">HTTP only</a></p>
          <p><a href="mailto:migration-qa@example.com?subject=Hello">mailto with subject</a></p>
          <p><a href="https://example.com/search?q=gmail+outlook&amp;utf8=✓">Query + unicode</a></p>
          <p><a href="https://learn.microsoft.com/graph/">Microsoft Graph docs</a></p>
        </body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Emoji density 🎯📎✨ mixed scripts',
        textBody: '🎉'.repeat(12) + ' plain • tab\there • newline\nnext line',
        htmlBody: `<html><body><p>${'🙂❤️📧'.repeat(8)}</p>
          <p>αβγ Δ Ε • 中文 • العربية • 한글</p>
          <p>${reactionNote}</p></body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format plain (multiline bullets arrows currency)',
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - All text formats comprehensive',
        textBody: 'All Gmail compose toolbar formats: bold, italic, underline, strikethrough, font size/family, colors, alignment, lists, blockquote, indent, unicode.',
        htmlBody: `<html><body>
<p><strong>Bold text</strong></p>
<p><em>Italic text</em></p>
<p><u>Underlined text</u></p>
<p><s>Strikethrough text</s></p>
<p><strong><em>Bold and Italic combined</em></strong></p>
<p><strong><em><u>Bold Italic Underline all three</u></em></strong></p>
<p><strong><s>Bold Strikethrough</s></strong></p>
<p><span style="font-size:10px">Small font (10px)</span></p>
<p><span style="font-size:14px">Normal font (14px)</span></p>
<p><span style="font-size:18px">Large font (18px)</span></p>
<p><span style="font-size:24px">Extra large font (24px)</span></p>
<p><span style="font-family:Georgia,serif">Georgia serif font</span></p>
<p><span style="font-family:'Courier New',monospace">Courier monospace font</span></p>
<p><span style="font-family:Arial,sans-serif">Arial sans-serif font</span></p>
<p><span style="color:#cc0000">Red colored text</span></p>
<p><span style="color:#1a73e8">Blue colored text</span></p>
<p><span style="color:#188038">Green colored text</span></p>
<p><span style="background-color:#ffd600">Yellow highlighted text</span></p>
<p><span style="color:#cc0000;background-color:#ffd600"><strong>Bold red on yellow highlight</strong></span></p>
<p style="text-align:left">Left aligned paragraph</p>
<p style="text-align:center">Center aligned paragraph</p>
<p style="text-align:right">Right aligned paragraph</p>
<p style="text-align:justify">Justified paragraph — longer text to demonstrate full-width justification across the line in migration.</p>
<ol><li>Ordered item one</li><li>Ordered item two</li><li>Ordered item three</li></ol>
<ul><li>Bullet item one</li><li>Bullet item two</li><li>Bullet item three</li></ul>
<ul><li>Parent bullet<ul><li>Nested child bullet one</li><li>Nested child bullet two</li></ul></li></ul>
<blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Blockquote — indented quoted block for migration testing.</blockquote>
<p style="padding-left:40px">Single indent paragraph</p>
<p style="padding-left:80px">Double indent paragraph</p>
<p>Line1<br>Line2<br>Line3<br>• bullet &nbsp; → arrow &nbsp; € £ ¥ § ™ © ®</p>
</body></html>`,
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format bold italic underline strikethrough',
        textBody: 'Bold / italic / underline / strikethrough format test.',
        htmlBody: '<html><body><p><strong>Bold</strong> — <em>Italic</em> — <u>Underline</u> — <s>Strikethrough</s></p><p><strong><em><u><s>All four combined</s></u></em></strong></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format font sizes',
        textBody: 'Font size format test: small normal large extra-large.',
        htmlBody: '<html><body><p><span style="font-size:10px">Small (10px)</span></p><p><span style="font-size:14px">Normal (14px)</span></p><p><span style="font-size:18px">Large (18px)</span></p><p><span style="font-size:24px">Extra Large (24px)</span></p><p><span style="font-size:36px">Huge (36px)</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format font families',
        textBody: 'Font family format test: sans-serif, serif, monospace.',
        htmlBody: '<html><body><p><span style="font-family:Arial,sans-serif">Arial sans-serif</span></p><p><span style="font-family:Georgia,serif">Georgia serif</span></p><p><span style="font-family:\'Courier New\',monospace">Courier New monospace</span></p><p><span style="font-family:Tahoma,sans-serif">Tahoma</span></p><p><span style="font-family:Verdana,sans-serif">Verdana</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format text colors and highlights',
        textBody: 'Text color and highlight format test.',
        htmlBody: '<html><body><p><span style="color:#cc0000">Red text</span></p><p><span style="color:#1a73e8">Blue text</span></p><p><span style="color:#188038">Green text</span></p><p><span style="color:#e37400">Orange text</span></p><p><span style="color:#9c27b0">Purple text</span></p><p><span style="background-color:#ffd600">Yellow highlight</span></p><p><span style="background-color:#b2dfdb">Teal highlight</span></p><p><span style="color:#cc0000;background-color:#ffd600">Red text yellow background</span></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format alignment (left center right justify)',
        textBody: 'Text alignment format test.',
        htmlBody: '<html><body><p style="text-align:left">Left aligned text</p><p style="text-align:center">Center aligned text</p><p style="text-align:right">Right aligned text</p><p style="text-align:justify">Justified text — this paragraph has enough words to stretch across the full width and demonstrate text justification in migration from Gmail to Outlook.</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format ordered and unordered lists',
        textBody: 'Ordered and unordered list format test.',
        htmlBody: '<html><body><ol><li>First ordered item</li><li>Second ordered item</li><li>Third ordered item</li></ol><ul><li>First bullet item</li><li>Second bullet item</li><li>Third bullet item</li></ul><ul><li>Parent item<ul><li>Nested child one</li><li>Nested child two<ul><li>Deep nested level</li></ul></li></ul></li></ul><ol><li>Ordered parent<ol><li>Ordered sub-item</li><li>Another sub-item</li></ol></li></ol></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Text format blockquote and indent',
        textBody: 'Blockquote and indent format test.',
        htmlBody: '<html><body><p>Normal paragraph before blockquote.</p><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Single level blockquote text.</blockquote><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px"><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Double nested blockquote.</blockquote></blockquote><p style="padding-left:40px">Single indent paragraph.</p><p style="padding-left:80px">Double indent paragraph.</p><p style="padding-left:120px">Triple indent paragraph.</p><p>Normal paragraph after.</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA E2E - Cc Bcc txt attachment + HTML link',
        textBody: 'Combo: Cc + Bcc + attachment + formatted link body.',
        htmlBody:
          '<html><body><p><a href="https://example.com/migration">Migration link</a></p><p><strong>Bold</strong> <em>italic</em></p></body></html>',
        labelIds: ['SENT'],
        cc: ccEmail,
        bcc: ccEmail,
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
      },
      {
        subject: 'QA E2E - Attachment DOCX document',
        textBody: 'E2E: Word document attachment migration (DOCX MIME type and filename validation).',
        labelIds: ['SENT'],
        attachments: [{
          filename: 'qa-document.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          data: SAMPLE_DOCX_B64,
        }],
      },
      {
        subject: 'QA E2E - Attachment XLSX spreadsheet',
        textBody: 'E2E: Excel spreadsheet attachment migration (XLSX MIME type and filename validation).',
        labelIds: ['SENT'],
        attachments: [{
          filename: 'qa-spreadsheet.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: SAMPLE_XLSX_B64,
        }],
      },
      {
        subject: 'QA E2E - BCC Only (no TO recipient)',
        textBody: 'E2E: Sent message addressed only via BCC (no To: or Cc:). Validates BCC-only migration and header handling.',
        labelIds: ['SENT'],
        toOverride: '',
        bcc: bccEmail,
      },
      // ── P3-8: Missing scenarios ────────────────────────────────────────────
      {
        subject: 'QA Gmail - Many TO Recipients Test',
        textBody: 'E2E: Sent message with 5 recipients in the To field. Validates multi-recipient To header migration.',
        labelIds: ['SENT'],
        toOverride: [
          correspondentEmail,
          ccEmail,
          bccEmail,
          'qa-recipient4@external-qa.com',
          'qa-recipient5@external-qa.com',
        ].filter((e, i, arr) => e && arr.indexOf(e) === i).join(', '),
      },
      {
        subject: '',
        keepSubjectRaw: true,
        textBody: 'E2E: Sent message with an empty subject line. Validates empty-subject migration and display in Outlook.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Gmail - ICS Attachment Test',
        textBody: 'E2E: Sent message with an .ics calendar file attachment. Validates ICS MIME type and filename migration.',
        labelIds: ['SENT'],
        attachments: [{ filename: 'qa-meeting.ics', mimeType: 'text/calendar', data: SAMPLE_ICS_B64 }],
      },
      {
        subject: 'QA Gmail - Large Body Email (~50KB)',
        textBody: 'QA large body preamble:\n\n' + 'A'.repeat(49800) + '\n\nEnd of large body.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Gmail - Reply-To Different From From',
        textBody: 'E2E: Sent message where Reply-To header differs from From. Validates Reply-To preservation across migration.',
        labelIds: ['SENT'],
        replyTo: 'qa-replyto@external-qa.com',
      },

      // ── Inscope features: dedicated standalone scenarios ────────────────────

      // 2. Starred (dedicated subject for inscope "Starred" feature)
      {
        subject: 'QA Gmail - Starred Email Test',
        textBody: 'E2E: Dedicated starred message seed. STARRED system label verifies that Gmail starred items migrate to Outlook flagged/starred correctly.',
        labelIds: ['SENT', 'STARRED'],
      },

      // 4. Migrate Archives (G→O inscope) — archived = INBOX label removed, lives in All Mail only.
      //    Covers: plain, with attachment, starred, important, with custom label, sent-archived,
      //    unread-archived, HTML body, multi-label archived — one per folder/label context.

      // 4a. Basic archived (plain text, All Mail only)
      {
        subject: 'QA Gmail - Archived Plain Text',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[0],
        textBody: 'Archived plain text email — in All Mail only, not in Inbox.',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived plain text (All Mail only): ${msgId}`);
        },
      },
      // 4b. Archived with PDF attachment
      {
        subject: 'QA Gmail - Archived With PDF Attachment',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[1],
        textBody: 'Archived email with PDF attachment — validates attachment migration from All Mail.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'archive-doc.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived + PDF attachment (All Mail only): ${msgId}`);
        },
      },
      // 4c. Archived + Starred
      {
        subject: 'QA Gmail - Archived Starred Email',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[2],
        textBody: 'Archived and starred email — validates star flag migration from All Mail.',
        labelIds: ['INBOX', 'STARRED'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived + starred (All Mail + STARRED): ${msgId}`);
        },
      },
      // 4d. Archived + Important
      {
        subject: 'QA Gmail - Archived Important Email',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[3],
        textBody: 'Archived important email — validates importance flag migration from All Mail.',
        labelIds: ['INBOX', 'IMPORTANT'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived + important (All Mail + IMPORTANT): ${msgId}`);
        },
      },
      // 4e. Archived with custom label (QA-Archive) — label stays, INBOX removed
      {
        subject: 'QA Gmail - Archived With QA-Archive Label',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[4],
        textBody: 'Archived email with QA-Archive custom label — All Mail + custom label, no Inbox.',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          const lbls = await gmailClient.listLabels(src, 'me').catch(() => []);
          const archiveLbl = lbls.find(l => l.name === 'QA-Archive');
          const toAdd = archiveLbl ? [archiveLbl.id] : [];
          await gmailClient.modifyMessageLabels(src, 'me', msgId, toAdd, ['INBOX']);
          lg.info(`Archived + QA-Archive label (All Mail + custom label): ${msgId}`);
        },
      },
      // 4f. Archived sent email (outbound, no INBOX by default — validate All Mail presence)
      {
        subject: 'QA Gmail - Archived Sent Email',
        textBody: 'Archived sent email — SENT label only, no Inbox. Validates outbound All Mail migration.',
        labelIds: ['SENT'],
      },
      // 4g. Archived unread (INBOX removed, UNREAD stays)
      {
        subject: 'QA Gmail - Archived Unread Email',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[0],
        textBody: 'Archived unread email — UNREAD label stays, INBOX removed.',
        labelIds: ['INBOX', 'UNREAD'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived + unread (All Mail + UNREAD): ${msgId}`);
        },
      },
      // 4h. Archived HTML body email
      {
        subject: 'QA Gmail - Archived HTML Body Email',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[1],
        htmlBody: '<html><body><h2>Archived HTML Email</h2><p><b>Bold</b> and <i>italic</i> content.</p><ul><li>Item 1</li><li>Item 2</li></ul></body></html>',
        textBody: 'Archived HTML email — fallback plain text.',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived HTML body (All Mail only): ${msgId}`);
        },
      },
      // 4i. Archived with multiple attachments (DOCX + XLSX)
      {
        subject: 'QA Gmail - Archived Multiple Attachments',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[2],
        textBody: 'Archived email with DOCX + XLSX attachments.',
        labelIds: ['INBOX'],
        attachments: [
          { filename: 'archive.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 },
          { filename: 'archive.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       data: SAMPLE_XLSX_B64 },
        ],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`Archived + DOCX+XLSX attachments (All Mail only): ${msgId}`);
        },
      },
      // 4j. Archived with QA-E2E-Staging custom label
      {
        subject: 'QA Gmail - Archived With Custom Label (Staging)',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[3],
        textBody: 'Archived email with QA-E2E-Staging label — validates custom label + archive migration.',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          const lbls = await gmailClient.listLabels(src, 'me').catch(() => []);
          const stagingLbl = lbls.find(l => l.name === 'QA-E2E-Staging');
          const toAdd = stagingLbl ? [stagingLbl.id] : [];
          await gmailClient.modifyMessageLabels(src, 'me', msgId, toAdd, ['INBOX']);
          lg.info(`Archived + QA-E2E-Staging label (All Mail + custom): ${msgId}`);
        },
      },

      // 6. Signature (G→O inscope) — dedicated message with a visible HTML signature block.
      {
        subject: 'QA Gmail - Email With Signature Block',
        htmlBody: `<html><body>
          <p>Hi,</p>
          <p>This is an E2E test email seeded to validate Gmail signature migration to Outlook.</p>
          <p>Please review the attached details and let me know if you have questions.</p>
          <br/>
          <p>—<br/>
          Migration QA Agent<br/>
          CloudFuze QA Team<br/>
          qa-agent@cloudfuze.com<br/>
          +1 (555) 000-0000<br/>
          <a href="https://www.cloudfuze.com">www.cloudfuze.com</a></p>
        </body></html>`,
        textBody: 'Hi,\n\nThis is an E2E test email seeded to validate Gmail signature migration to Outlook.\n\n—\nMigration QA Agent\nCloudFuze QA Team\nqa-agent@cloudfuze.com\n+1 (555) 000-0000',
        labelIds: ['SENT'],
      },
    ];

    const custom = [];
    const addIf = (name, subject, body) => {
      const id = qaIds[name];
      if (id) custom.push({ subject, textBody: body, labelIds: [id], mailDirection: 'incoming', inboundFrom: inboundSenders?.[0] || toEmail });
    };
    addIf('QA-TestLabel', 'QA E2E - In QA-TestLabel', 'E2E: user label QA-TestLabel.');
    addIf('QA-TestLabel', 'QA E2E - Second mail in QA-TestLabel', 'E2E: second message under QA-TestLabel.');
    addIf('QA-Important', 'QA E2E - In QA-Important', 'E2E: user label QA-Important.');
    addIf('QA-Important', 'QA E2E - Second mail in QA-Important', 'E2E: second message under QA-Important.');
    addIf('QA-Archive', 'QA E2E - In QA-Archive', 'E2E: user label QA-Archive.');
    addIf(
      'QA-TestLabel/Nested-Child',
      'QA E2E - In QA-TestLabel/Nested-Child',
      'E2E: nested user label (2-level nesting).'
    );
    addIf(
      'QA-TestLabel/Nested-Child/Deep-Level',
      'QA E2E - In QA-TestLabel/Nested-Child/Deep-Level',
      'E2E: deeply nested user label (3-level nesting) for nested label migration QA.'
    );
    addIf('QA-E2E-Staging', 'QA E2E - In QA-E2E-Staging', 'E2E: staging label + Sent.');
    addIf('QA-E2E-Staging', 'QA E2E - Staging follow-up', 'E2E: second mail in QA-E2E-Staging.');
    addIf('QA-E2E-Compliance', 'QA E2E - In QA-E2E-Compliance', 'E2E: compliance label + Sent.');
    addIf('QA-E2E-Compliance', 'QA E2E - Compliance attachment note', 'E2E: second mail in QA-E2E-Compliance.');
    addIf('ProjectX', 'QA E2E - PDF 3.5 ProjectX (A)', 'GMAIL TO OUTLOOK PDF: label ProjectX → Outlook folder.');
    addIf('ProjectX', 'QA E2E - PDF 3.5 ProjectX (B)', 'Second mail under ProjectX.');
    addIf('AutoLabel', 'QA E2E - PDF AutoLabel', 'Smoke PDF 3.18 / PDF 3.16: filter/rule label target.');

    // 3. Migrate Orphaned Labels (G→O inscope) — two types per docs:
    //    Type A: Custom label with no Outlook equivalent (label-only, not in Inbox/Sent)
    //    Type B: No-label email — ALL labels removed, exists ONLY in All Mail (true "no label" orphan)

    // Type A — custom label, no Outlook folder equivalent
    addIf('QA-Orphaned-Label', 'QA Gmail - Orphaned Label Test', 'E2E: Message in QA-Orphaned-Label — a custom Gmail label that has no equivalent Outlook folder. CloudFuze should create a matching folder in Outlook when Migrate Orphaned Labels is enabled.');
    addIf('QA-Orphaned-Label', 'QA Gmail - Orphaned Label Test (second)', 'E2E: Second message in QA-Orphaned-Label to confirm multi-message orphaned label migration.');
    addIf('QA-Orphaned-Label', 'QA Gmail - Orphaned Label With Attachment', 'E2E: Orphaned label email with PDF attachment — validates attachment migration for orphaned label emails.');

    // Type B — no-label emails (true All Mail only, ALL labels stripped via postInsert)
    // Per docs: "A no label email is created by removing from Inbox AND all labels"
    const noLabelOrphans = [
      {
        subject: 'QA Gmail - No Label Email (All Mail Only)',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[0],
        textBody: 'E2E: True no-label email — all labels removed including INBOX. Email exists only in Gmail All Mail. Validates Migrate Orphaned Labels feature: CloudFuze should migrate this to Outlook even though it has no labels.',
        labelIds: ['INBOX'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`No-label orphaned email (All Mail only, no labels): ${msgId}`);
        },
      },
      {
        subject: 'QA Gmail - No Label Email With Attachment (All Mail Only)',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[1],
        textBody: 'E2E: True no-label email with attachment — all labels removed. Validates that attachments are preserved when migrating no-label orphaned emails.',
        labelIds: ['INBOX'],
        attachments: [{ filename: 'orphan-doc.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`No-label orphaned email + PDF attachment (All Mail only): ${msgId}`);
        },
      },
      {
        subject: 'QA Gmail - No Label Unread Email (All Mail Only)',
        mailDirection: 'incoming',
        inboundFrom: FALLBACK_EXTERNAL_CORRESPONDENTS[2],
        textBody: 'E2E: Unread no-label email — INBOX removed but UNREAD stays. Validates read state migration for orphaned emails.',
        labelIds: ['INBOX', 'UNREAD'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [], ['INBOX']);
          lg.info(`No-label unread orphaned email (All Mail + UNREAD only): ${msgId}`);
        },
      },
    ];

    // 4. Shared Mailbox (G→G inscope) — simulate shared mailbox content via a dedicated label.
    //    Shared Mailbox is inscope for G→G migration. This message is tagged with QA-Shared-Mailbox
    //    to verify that shared mailbox content (simulated via label) migrates correctly in G→G runs.
    addIf('QA-Shared-Mailbox', 'QA Gmail - Shared Mailbox Email Test', 'E2E (G→G inscope): Simulated shared mailbox content. This message is tagged with QA-Shared-Mailbox label to validate that shared mailbox content migrates correctly in Gmail→Gmail migration. Shared Mailbox is inscope for G→G.');

    /** PDF 3.6 — multiple user labels on one message */
    const multiLabelOne = [];
    const idMultA = qaIds['QA-TestLabel'];
    const idMultB = qaIds['QA-E2E-Staging'];
    if (idMultA && idMultB) {
      multiLabelOne.push({
        subject: 'QA E2E - PDF 3.6 Multiple labels one message',
        textBody: 'GMAIL TO OUTLOOK PDF 3.6: one message with two user labels.',
        labelIds: ['SENT', idMultA, idMultB],
      });
    }

    /** Messages that exist only under a custom label (not in Sent/Inbox) — folder migration coverage */
    const labelOnly = [];
    for (const name of ['QA-Archive', 'QA-E2E-Compliance', 'QA-E2E-Staging']) {
      const id = qaIds[name];
      if (id) {
        labelOnly.push({
          subject: `QA E2E - Label-only · ${name}`,
          textBody: `E2E: message appears only under user label "${name}" (not in Sent/Inbox).`,
          labelIds: [id],
        });
      }
    }

    const snooze = [];
    if (snoozeId) {
      snooze.push({
        subject: 'QA E2E - Snoozed label',
        textBody: 'E2E: Sent + Snoozed label applied via API (snooze time not set).',
        labelIds: ['SENT'],
        postInsert: async (src, msgId, lg) => {
          await gmailClient.modifyMessageLabels(src, 'me', msgId, [snoozeId], []);
          lg.info(`Applied Snoozed label to message ${msgId}`);
        },
      });
    }

    const inbound = buildInboundInboxSeeds('QA E2E', correspondentEmail, ccEmail, { mode: 'full' });

    return [...base, ...custom, ...multiLabelOne, ...labelOnly, ...snooze, ...inbound, ...noLabelOrphans];
  }

  /**
   * Smoke PDF 3.15 / GMAIL PDF 3.12 — two messages in one Gmail thread for Outlook conversation view.
   */
  async _seedPdfConversationThread(sourceEmail, toEmail, summary, log, executionId) {
    if (executionId && executionService.isCancelled(executionId)) return;
    try {
      const rawRoot = gmailClient.buildRawMessage({
        to: toEmail,
        from: sourceEmail,
        subject: 'QA E2E - PDF Thread root (conversation)',
        textBody: 'Root message for conversation / thread migration (PDF scenarios).',
      });
      const root = await gmailClient.insertEmail(sourceEmail, 'me', rawRoot, ['SENT']);
      await reconcileInsertedMessageLabels(
        sourceEmail,
        { labelIds: ['SENT'] },
        root?.id,
        log
      );
      const tid = root.threadId;
      if (!tid) {
        log.warn('E2E conversation seed: no threadId from Gmail');
        return;
      }
      const rawReply = gmailClient.buildRawMessage({
        to: toEmail,
        from: sourceEmail,
        subject: 'Re: QA E2E - PDF Thread root (conversation)',
        textBody: 'Reply in the same Gmail thread for Outlook conversation grouping.',
      });
      const reply = await gmailClient.insertEmail(sourceEmail, 'me', rawReply, ['SENT'], { threadId: tid });
      await reconcileInsertedMessageLabels(sourceEmail, { labelIds: ['SENT'] }, reply?.id, log);
      summary.emailsCreated += 2;
      log.info('E2E: seeded PDF conversation thread (2 messages)');
    } catch (err) {
      log.warn(`E2E conversation thread seed failed: ${err.message}`);
    }
  }

  async _createEmails(sourceEmail, toEmail, ccEmail, bccEmail, inboundSenders, testType, summary, log, executionId) {
    const smokeOutbound = [
      {
        subject: 'QA Smoke - Plain Text Email',
        textBody: 'Smoke test: plain text email for migration connectivity check.',
        labelIds: ['SENT'],
      },
    ];
    const smokeEmails = [
      ...smokeOutbound,
      ...buildInboundInboxSeeds('QA Smoke', inboundSenders, ccEmail, { mode: 'minimal' }),
    ];

    const sanityOutbound = [
      {
        subject: 'QA Sanity - Plain Text Email',
        textBody: 'Sanity test: plain text email for migration testing.',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - HTML Email',
        htmlBody: `<html><body><h1>HTML Test</h1><p>This is an <strong>HTML email</strong> for sanity testing.</p></body></html>`,
        textBody: 'HTML Test Email - fallback',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Email with Attachment',
        textBody: 'Sanity test: email with attachment.',
        attachments: [{ filename: 'test-document.txt', mimeType: 'text/plain', data: SAMPLE_ATTACHMENT_DATA }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format plain (multiline bullets arrows currency)',
        textBody: 'Line1\nLine2\nLine3\n• bullet\n→ arrow\n€ £ ¥',
        htmlBody: '<html><body><p>Line1<br>Line2<br>Line3</p><p>• bullet</p><p>→ arrow</p><p>€ £ ¥</p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format bold italic underline strikethrough',
        textBody: 'Bold italic underline strikethrough format test.',
        htmlBody: '<html><body><p><strong>Bold</strong> — <em>Italic</em> — <u>Underline</u> — <s>Strikethrough</s></p><p><strong><em><u>Bold Italic Underline combined</u></em></strong></p></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text format lists and alignment',
        textBody: 'Lists and alignment format test.',
        htmlBody: '<html><body><ol><li>Ordered one</li><li>Ordered two</li></ol><ul><li>Bullet one</li><li>Bullet two</li></ul><p style="text-align:center">Center aligned</p><p style="text-align:right">Right aligned</p><blockquote style="margin:0 0 0 40px;border-left:4px solid #ccc;padding-left:8px">Blockquote text</blockquote></body></html>',
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text with file (PNG image)',
        textBody: 'Please find the screenshot attached.',
        attachments: [{ filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 }],
        labelIds: ['SENT'],
      },
      {
        subject: 'QA Sanity - Text with two files (PNG and CSV)',
        textBody: 'Sending 2 attachments',
        attachments: [
          { filename: 'qa-screenshot.png', mimeType: 'image/png', data: SAMPLE_PNG_B64 },
          { filename: 'qa-report.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ],
        labelIds: ['SENT'],
      },
    ];
    const sanityEmails = [
      ...sanityOutbound,
      ...buildInboundInboxSeeds('QA Sanity', inboundSenders, ccEmail, { mode: 'standard' }),
    ];

    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const excelSamples = {
      attachmentData: SAMPLE_ATTACHMENT_DATA,
      inlineImageData: SAMPLE_INLINE_IMAGE,
      secondAttachmentData: SAMPLE_ATTACHMENT_SECOND,
      minimalPdfData: SAMPLE_MINIMAL_PDF_B64,
      largeAttachmentData: SAMPLE_LARGE_B64,
      small1kData: SAMPLE_1K_B64,
      medium100kData: SAMPLE_100K_B64,
      xlarge512kData: SAMPLE_512K_B64,
      jpegAttachmentData: SAMPLE_JPEG_B64,
      pngAttachmentData: SAMPLE_PNG_B64,
      zipAttachmentData: SAMPLE_ZIP_B64,
      huge2mData: SAMPLE_2M_B64,
      csvAttachmentData: SAMPLE_CSV_B64,
    };

    let emails;
    if (testType === 'E2E') {
      const { qaIds, snoozeId } = await this._loadE2ELabelContext(sourceEmail, log);
      const xlsxEmails = tryLoadMailCasesFromExcel(xlsxPath, 'E2E', {
        qaIds,
        snoozeId,
        ccEmail,
        bccEmail,
        sourceEmail,
        samples: excelSamples,
        log,
      });
      if (xlsxEmails) {
        // Always append inbound seeds so Inbox is populated even when xlsx is used
        const inbound = buildInboundInboxSeeds('QA E2E', inboundSenders, ccEmail, { mode: 'full' });
        emails = [...xlsxEmails, ...inbound];
      } else {
        emails = this._e2eEmailDefinitions(qaIds, snoozeId, ccEmail, bccEmail, sourceEmail, toEmail);
      }
    } else {
      const xlsxEmails = tryLoadMailCasesFromExcel(xlsxPath, testType, {
        qaIds: {},
        snoozeId: null,
        ccEmail,
        bccEmail,
        sourceEmail,
        samples: excelSamples,
        log,
      });
      if (xlsxEmails) {
        const mode = testType === 'SMOKE' ? 'minimal' : 'standard';
        const prefix = testType === 'SMOKE' ? 'QA Smoke' : 'QA Sanity';
        const inbound = buildInboundInboxSeeds(prefix, inboundSenders, ccEmail, { mode });
        emails = [...xlsxEmails, ...inbound];
      } else {
        emails = testType === 'SMOKE' ? smokeEmails : sanityEmails;
      }
    }

    // Append custom test cases saved via the Test Case Generator (smoke/sanity only)
    if (testType !== 'E2E') {
      emails = [...emails, ...loadCustomTestCases(testType, log)];
    }

    /**
     * Insert a running counter into every subject so operators can reference each
     * seeded message by number in the validation PDF and the Gmail UI.
     *   "QA E2E - Plain Text Email"      →  "QA E2E 1 - Plain Text Email"
     *   "QA Sanity - Inbound plain"      →  "QA Sanity 2 - Inbound plain"
     * Applied here so Excel rows, JS fallbacks, and custom cases are all numbered.
     */
    applyRunningSubjectNumbering(emails);
    // Apply 20% unread / 80% read distribution across all base emails
    applyReadUnreadDistribution(emails, 20);

    for (const emailDef of emails) {
      if (executionId && executionService.isCancelled(executionId)) {
        log.info('Email insertion cancelled by user');
        break;
      }
      try {
        const incoming = emailDef.mailDirection === 'incoming';
        // Rotated inbound sender (insert-only — no mail ever leaves this process; we only
        // call users.messages.insert on the source mailbox, no correspondent mailbox is touched).
        const inboundFrom = incoming
          ? String(emailDef.inboundFrom || toEmail || '').trim() || toEmail
          : null;
        const raw = gmailClient.buildRawMessage(
          incoming
            ? {
                to: sourceEmail,
                from: inboundFrom,
                cc: emailDef.cc,
                bcc: emailDef.bcc,
                replyTo: emailDef.replyTo,
                subject: emailDef.subject,
                textBody: emailDef.textBody,
                htmlBody: emailDef.htmlBody,
                attachments: emailDef.attachments || [],
                inlineImages: emailDef.inlineImages || [],
              }
            : {
                to: emailDef.toOverride !== undefined ? emailDef.toOverride : toEmail,
                from: sourceEmail,
                cc: emailDef.cc,
                bcc: emailDef.bcc,
                replyTo: emailDef.replyTo,
                subject: emailDef.subject,
                textBody: emailDef.textBody,
                htmlBody: emailDef.htmlBody,
                attachments: emailDef.attachments || [],
                inlineImages: emailDef.inlineImages || [],
              }
        );

        const resolvedLabelIds = await resolveCustomLabelIds(
          sourceEmail,
          emailDef.labelIds || (incoming ? ['INBOX'] : ['SENT'])
        );
        const data = await gmailClient.insertEmail(
          sourceEmail,
          'me',
          raw,
          resolvedLabelIds,
          emailDef.insertOpts || {}
        );
        summary.emailsCreated++;
        log.info(`Inserted email: ${emailDef.subject}`);
        if (data?.id) {
          await reconcileInsertedMessageLabels(sourceEmail, emailDef, data.id, log);
        }
        if (typeof emailDef.postInsert === 'function' && data?.id) {
          await emailDef.postInsert(sourceEmail, data.id, log);
        }
      } catch (err) {
        log.error(`Failed to insert email "${emailDef.subject}": ${err.message}`);
      }
    }

    if (testType === 'E2E' && (!executionId || !executionService.isCancelled(executionId))) {
      await this._seedPdfConversationThread(sourceEmail, toEmail, summary, log, executionId);
      await this._createExtendedE2ETestData(sourceEmail, toEmail, ccEmail, inboundSenders, summary, log, executionId);
    }
  }

  /**
   * Extended E2E scenarios for Gmail → Outlook migration.
   * Mirrors OutlookTestDataAgent §26, §32, §33, §34, §35, §37, §38, §39, §44, §45 — the
   * scenarios present in Outlook E2E but previously missing from Gmail E2E.
   * All inscope features per CloudFuze docs (G→O): Timestamp, Threads, Starred, Important,
   * Custom Folders, Migrate Archives, Migrate Orphaned Labels, Filters/rules, Signature, Contacts.
   */
  async _createExtendedE2ETestData(sourceEmail, toEmail, ccEmail, inboundSenders, summary, log, executionId) {
    const cancelled = () => executionId && executionService.isCancelled(executionId);

    // Track eligible emails (not in SENT/SPAM/TRASH) and mark every 5th as UNREAD (20%)
    let eligibleInsertCount = 0;
    const skipUnreadFolders = new Set(['SENT', 'SPAM', 'TRASH', 'DRAFT']);

    const insert = async (def) => {
      if (cancelled()) return;
      // Auto-apply 20% unread distribution to eligible inbox/label emails
      const labels = def.labelIds || [];
      const inSkipFolder = labels.some(l => skipUnreadFolders.has(String(l).toUpperCase()));
      const alreadyUnread = labels.includes('UNREAD');
      if (!inSkipFolder && !alreadyUnread) {
        eligibleInsertCount++;
        if (eligibleInsertCount % 5 === 0) {
          def = { ...def, labelIds: [...labels, 'UNREAD'] };
        }
      }
      try {
        const incoming = def.mailDirection === 'incoming';
        const fromAddr = incoming ? (def.inboundFrom || (inboundSenders[0] || toEmail)) : sourceEmail;
        const toAddr   = incoming ? sourceEmail : (def.to || toEmail);
        const raw = gmailClient.buildRawMessage({
          from: fromAddr, to: toAddr,
          cc: def.cc, bcc: def.bcc,
          subject: def.subject,
          textBody: def.textBody, htmlBody: def.htmlBody,
          attachments: def.attachments,
          replyTo: def.replyTo,
          date: def.date,
          inReplyTo: def.inReplyTo, references: def.references,
          messageId: def.messageId,
        });
        const labels = def.labelIds || (incoming ? ['INBOX'] : ['SENT']);
        const opts   = def.insertOpts || {};
        const data   = await gmailClient.insertEmail(sourceEmail, 'me', raw, labels, opts);
        summary.emailsCreated++;
        log.info(`✓ Extended E2E: "${def.subject}"`);
        if (data?.id) await reconcileInsertedMessageLabels(sourceEmail, def, data.id, log);
        if (typeof def.postInsert === 'function' && data?.id) await def.postInsert(sourceEmail, data.id, log);
        return data;
      } catch (err) {
        log.warn(`Extended E2E: failed "${def.subject}": ${err.message}`);
        return null;
      }
    };

    // ── §103 — Historical/old-dated emails (Timestamp inscope) ─────────────────
    // Gmail API: internalDateSource='dateHeader' uses the Date: header from the raw MIME.
    // We set a custom Date: header in buildRawMessage via the `date` field.
    log.info('Gmail E2E §103: historical emails (2019)…');
    await insert({
      subject: 'QA E2E 103 - Historical Inbox Email (2019)',
      textBody: 'Historical email from 2019 — validates that original timestamps are preserved during migration.',
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
      date: new Date('2019-06-15T10:30:00Z'),
      insertOpts: { internalDate: true },
    });
    await insert({
      subject: 'QA E2E 103 - Historical Sent Email (2019)',
      textBody: 'Historical sent email from 2019 — validates sent timestamp preservation.',
      labelIds: ['SENT'],
      date: new Date('2019-11-20T14:45:00Z'),
      insertOpts: { internalDate: true },
    });
    log.info('✓ §103 complete — 2 historical emails (2019 timestamps)');

    if (cancelled()) return;

    // ── §106 — Large body email (~50KB) ────────────────────────────────────────
    log.info('Gmail E2E §106: large body email (~50KB)…');
    const largeBody = 'A'.repeat(50000);
    await insert({
      subject: 'QA E2E 106 - Large Body Email (~50KB)',
      textBody: largeBody,
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
    });
    log.info('✓ §106 complete — 1 large body email');

    if (cancelled()) return;

    // ── §107 — Many TO recipients ──────────────────────────────────────────────
    log.info('Gmail E2E §107: many-TO-recipients email…');
    const manyTo = [toEmail, ccEmail, ...inboundSenders].filter(Boolean).slice(0, 8).join(', ');
    await insert({
      subject: 'QA E2E 107 - Many TO Recipients (8+)',
      textBody: 'Email with many TO recipients — validates recipient list migration.',
      labelIds: ['SENT'],
      to: manyTo,
    });
    log.info('✓ §107 complete — 1 many-TO email');

    if (cancelled()) return;

    // ── §108 — Mixed-language body ─────────────────────────────────────────────
    log.info('Gmail E2E §108: mixed-language body…');
    await insert({
      subject: 'QA E2E 108 - Mixed Language Body',
      textBody: 'English text. Кириллица. 日本語テスト. العربية. 中文测试. Ελληνικά. हिंदी.',
      htmlBody: '<html><body><p>English text.</p><p>Кириллица.</p><p>日本語テスト.</p><p>العربية.</p><p>中文测试.</p></body></html>',
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
    });
    log.info('✓ §108 complete — 1 mixed-language email');

    if (cancelled()) return;

    // ── §109 — ICS attachment email ────────────────────────────────────────────
    log.info('Gmail E2E §109: ICS attachment email…');
    await insert({
      subject: 'QA E2E 109 - ICS Attachment Email (Meeting Invite)',
      textBody: 'Email with .ics calendar attachment — validates ICS MIME type migration.',
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
      attachments: [{ filename: 'qa-meeting.ics', mimeType: 'text/calendar', data: SAMPLE_ICS_B64 }],
    });
    log.info('✓ §109 complete — 1 ICS attachment email');

    if (cancelled()) return;

    // ── §110 — Per-folder medium attachments (512KB, varied types) ────────────
    log.info('Gmail E2E §110: per-folder medium attachments…');
    const folderAttachScenarios = [
      { label: 'INBOX',  subject: 'QA E2E 110 - Inbox Medium Attachment (512KB PDF)',   filename: 'qa-attachment-512kb.pdf',  mime: 'application/pdf',                                                              data: SAMPLE_512K_PDF_B64, dir: 'incoming' },
      { label: 'SENT',   subject: 'QA E2E 110 - Sent Items Medium Attachment (512KB DOCX)', filename: 'qa-attachment-512kb.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64,  dir: 'outgoing' },
      { label: 'DRAFT',  subject: 'QA E2E 110 - Drafts Medium Attachment (512KB)',      filename: 'qa-attachment-512kb.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         data: SAMPLE_XLSX_B64, dir: 'draft'    },
      { label: 'SPAM',   subject: 'QA E2E 110 - Spam Attachment (512KB JPG)',            filename: 'qa-attachment-512kb.jpg',  mime: 'image/jpeg',                                                                 data: SAMPLE_JPEG_B64, dir: 'incoming' },
      { label: 'TRASH',  subject: 'QA E2E 110 - Deleted Medium Attachment (512KB PNG)', filename: 'qa-attachment-512kb.png',  mime: 'image/png',                                                                  data: SAMPLE_PNG_B64,  dir: 'incoming' },
    ];
    for (const s of folderAttachScenarios) {
      if (cancelled()) return;
      if (s.dir === 'draft') {
        try {
          const rawDraft = gmailClient.buildRawMessage({
            to: toEmail, from: sourceEmail, subject: s.subject,
            textBody: `Draft with ${s.filename} attachment for folder-level attachment migration QA.`,
            attachments: [{ filename: s.filename, mimeType: s.mime, data: s.data }],
          });
          await gmailClient.createDraft(sourceEmail, 'me', rawDraft);
          summary.emailsCreated++;
          log.info(`✓ Extended E2E: "${s.subject}"`);
        } catch (err) { log.warn(`Draft attachment failed: ${err.message}`); }
      } else {
        await insert({
          subject: s.subject,
          textBody: `${s.filename} attachment in ${s.label} — validates per-folder attachment migration.`,
          labelIds: [s.label],
          mailDirection: s.dir === 'incoming' ? 'incoming' : undefined,
          inboundFrom: s.dir === 'incoming' ? (inboundSenders[0] || toEmail) : undefined,
          attachments: [{ filename: s.filename, mimeType: s.mime, data: s.data }],
        });
      }
    }

    // Custom label multi-type attachment (mirrors Outlook §110 custom folders)
    const labelCtx = await this._loadE2ELabelContext(sourceEmail, log);
    const customLabelId = labelCtx?.migrationFolderLabelId || labelCtx?.workProjectsLabelId;
    if (customLabelId) {
      await insert({
        subject: 'QA E2E 110 - Custom Label Multi-Type Attachments (PDF+XLSX+DOCX+PNG+CSV)',
        textBody: 'Multi-type attachment email in custom label — validates attachment variety per label.',
        labelIds: ['SENT', customLabelId],
        attachments: [
          { filename: 'qa-multi.pdf',  mimeType: 'application/pdf',                                                              data: SAMPLE_MINIMAL_PDF_B64 },
          { filename: 'qa-multi.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',            data: SAMPLE_XLSX_B64 },
          { filename: 'qa-multi.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',      data: SAMPLE_DOCX_B64 },
          { filename: 'qa-multi.png',  mimeType: 'image/png',                                                                    data: SAMPLE_PNG_B64 },
          { filename: 'qa-multi.csv',  mimeType: 'text/csv',                                                                     data: SAMPLE_CSV_B64 },
        ],
      });
    }
    log.info('✓ §110 complete — per-folder attachment emails');

    if (cancelled()) return;

    // ── §111 — Rich body + multi-size attachments ──────────────────────────────
    log.info('Gmail E2E §111: rich body + multi-size attachments…');
    const richAttachments = [
      { filename: 'qa-attach-1kb.txt',  mimeType: 'text/plain',       data: SAMPLE_1K_B64  },
      { filename: 'qa-attach-100kb.bin',mimeType: 'application/octet-stream', data: SAMPLE_100K_B64 },
      { filename: 'qa-attach-512kb.pdf',mimeType: 'application/pdf',  data: SAMPLE_512K_PDF_B64 },
      { filename: 'qa-attach.docx',     mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 },
      { filename: 'qa-attach.xlsx',     mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       data: SAMPLE_XLSX_B64 },
    ];
    const richHtml = '<html><body><h2>Rich Body</h2><p><b>Bold</b> <i>italic</i> <u>underline</u> <s>strikethrough</s></p><p style="color:red">Red text</p><ul><li>Item 1</li><li>Item 2</li></ul><blockquote>Blockquote content</blockquote><pre>code block</pre></body></html>';
    await insert({
      subject: 'QA E2E 111 - Rich Body Multi-Attachment (Inbox)',
      htmlBody: richHtml,
      textBody: 'Rich body with 5 attachments spanning 1KB to 512KB — Inbox.',
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
      attachments: richAttachments,
    });
    await insert({
      subject: 'QA E2E 111 - Rich Body Multi-Attachment (Sent)',
      htmlBody: richHtml,
      textBody: 'Rich body with 5 attachments spanning 1KB to 512KB — Sent.',
      labelIds: ['SENT'],
      attachments: richAttachments,
    });
    log.info('✓ §111 complete — 2 rich-body multi-attachment emails');

    if (cancelled()) return;

    // ── §112 — Deep thread chain (10 messages, multiple participants) ──────────
    log.info('Gmail E2E §112: deep thread chain (10 messages)…');
    try {
      const threadSubject = 'QA E2E 112 - Deep Thread Chain (Multi-Participant All Labels)';
      const participants  = [sourceEmail, toEmail, ccEmail, inboundSenders[0]].filter(Boolean);
      let   prevMsgId     = null;
      let   threadId      = null;

      const threadMessages = [
        { from: sourceEmail, to: toEmail,     label: 'SENT',  body: 'Thread root — message 1 of 10.' },
        { from: toEmail,     to: sourceEmail, label: 'INBOX', body: 'Reply — message 2 of 10.', dir: 'incoming' },
        { from: sourceEmail, to: ccEmail,     label: 'SENT',  body: 'Reply with CC — message 3 of 10. See attached notes.', attachments: [{ filename: 'qa-thread-notes.txt', mimeType: 'text/plain', data: SAMPLE_1K_B64 }] },
        { from: ccEmail,     to: sourceEmail, label: 'INBOX', body: 'CC reply — message 4 of 10.', dir: 'incoming' },
        { from: sourceEmail, to: toEmail,     label: 'SENT',  body: 'Forward — message 5 of 10.', subject: `Fwd: ${threadSubject}` },
        { from: toEmail,     to: sourceEmail, label: 'INBOX', body: 'Reply to forward — message 6 of 10.', dir: 'incoming' },
        { from: sourceEmail, to: toEmail,     label: 'SENT',  body: 'Message 7 — kick-off agenda + review docs attached (3 files).', attachments: [
          { filename: 'qa-kickoff-agenda.txt', mimeType: 'text/plain', data: SAMPLE_1K_B64 },
          { filename: 'qa-kickoff-review.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 },
          { filename: 'qa-kickoff-checklist.csv', mimeType: 'text/csv', data: SAMPLE_CSV_B64 },
        ] },
        { from: toEmail,     to: sourceEmail, label: 'INBOX', body: 'Reply to attachment — message 8.', dir: 'incoming' },
        { from: sourceEmail, to: toEmail,     label: 'SENT',  body: 'Near-final message 9 of 10.' },
        { from: toEmail,     to: sourceEmail, label: 'INBOX', body: 'Final reply — message 10 of 10.', dir: 'incoming' },
      ];

      for (let i = 0; i < threadMessages.length; i++) {
        if (cancelled()) break;
        const tm  = threadMessages[i];
        const subj = tm.subject || (i === 0 ? threadSubject : `Re: ${threadSubject}`);
        const fromAddr = tm.dir === 'incoming' ? tm.from : sourceEmail;
        const toAddr   = tm.dir === 'incoming' ? sourceEmail : tm.to;
        const raw = gmailClient.buildRawMessage({
          from: fromAddr, to: toAddr,
          subject: subj,
          textBody: tm.body,
          attachments: tm.attachments,
          inReplyTo: prevMsgId,
          references:  prevMsgId,
        });
        const opts = threadId ? { threadId } : {};
        const data = await gmailClient.insertEmail(sourceEmail, 'me', raw, [tm.label], opts);
        if (data?.id) {
          await reconcileInsertedMessageLabels(sourceEmail, { labelIds: [tm.label], mailDirection: tm.dir === 'incoming' ? 'incoming' : undefined }, data.id, log);
          prevMsgId = `<qa-thread-${i}@cloudfuze.qa>`;
          if (!threadId && data.threadId) threadId = data.threadId;
          summary.emailsCreated++;
        }
      }
      log.info(`✓ §112 complete — 10-message deep thread chain (threadId=${threadId})`);
    } catch (err) {
      log.warn(`§112 deep thread chain failed: ${err.message}`);
    }

    if (cancelled()) return;

    // ── §117 — Multi-recipient thread chain spanning Inbox + 2 custom labels ────
    // A single conversation (shared threadId) where every message carries MULTIPLE
    // recipients (To has 2+ addresses, plus Cc), and the messages are distributed
    // across the Inbox and two custom labels (QA-Thread-Label-1 / -2). Validates that
    // a threaded conversation migrates intact while each message keeps its folder/label
    // placement and its full To/Cc recipient set.
    log.info('Gmail E2E §117: multi-recipient thread chain (Inbox + 2 custom labels)…');
    try {
      const allLabels = await gmailClient.listLabels(sourceEmail, 'me');
      const labelIdByName = (name) => (allLabels.find((l) => l.name === name) || {}).id || null;
      const labelA = labelIdByName('QA-Thread-Label-1');
      const labelB = labelIdByName('QA-Thread-Label-2');
      if (!labelA || !labelB) {
        log.warn(`§117 skipped — custom thread labels missing (QA-Thread-Label-1=${labelA}, QA-Thread-Label-2=${labelB})`);
      } else {
        const subject = 'QA E2E 117 - Multi-Recipient Thread Chain (Inbox + 2 Custom Labels)';
        const me = sourceEmail;
        const p1 = toEmail;
        const p2 = ccEmail;
        const p3 = inboundSenders[0] || toEmail;
        // Conversation distributed so it lives in the Inbox AND both custom labels.
        const chain = [
          { dir: 'incoming', from: p3, labels: ['INBOX'], body: 'Thread root — addressed to multiple recipients (To + Cc). Message 1 of 6.' },
          { dir: 'outgoing', from: me, labels: [labelA],  body: 'Reply filed under custom label 1 (QA-Thread-Label-1) — message 2 of 6.' },
          { dir: 'incoming', from: p1, labels: [labelB],  body: 'Reply filed under custom label 2 (QA-Thread-Label-2) — message 3 of 6.' },
          { dir: 'incoming', from: p3, labels: ['INBOX'], body: 'Group reply back in the Inbox — message 4 of 6.' },
          { dir: 'outgoing', from: me, labels: [labelA],  body: 'Second message under custom label 1 — message 5 of 6.' },
          { dir: 'incoming', from: p1, labels: [labelB],  body: 'Final reply under custom label 2 — message 6 of 6.' },
        ];
        let threadId = null;
        let prevMsgId = null;
        for (let i = 0; i < chain.length; i++) {
          if (cancelled()) break;
          const m = chain[i];
          const subj = i === 0 ? subject : `Re: ${subject}`;
          // Multiple recipients on every message: To gets all participants except the sender,
          // Cc gets p2 (when it isn't the sender) — so each header carries 2+ recipients.
          const toHdr = [me, p1, p3].filter((a) => a && a !== m.from).join(', ');
          const ccHdr = [p2].filter((a) => a && a !== m.from).join(', ');
          const myMsgId = `<qa-thread117-${i}@cloudfuze.qa>`;
          const raw = gmailClient.buildRawMessage({
            from: m.from,
            to: toHdr,
            cc: ccHdr,
            subject: subj,
            textBody: m.body,
            messageId: myMsgId,
            inReplyTo: prevMsgId,
            references: prevMsgId,
          });
          const opts = threadId ? { threadId } : {};
          const data = await gmailClient.insertEmail(sourceEmail, 'me', raw, m.labels, opts);
          if (data?.id) {
            await reconcileInsertedMessageLabels(
              sourceEmail,
              { labelIds: m.labels, mailDirection: m.dir === 'incoming' ? 'incoming' : undefined },
              data.id,
              log
            );
            prevMsgId = myMsgId;
            if (!threadId && data.threadId) threadId = data.threadId;
            summary.emailsCreated++;
          }
        }
        log.info(`✓ §117 complete — 6-message multi-recipient thread across Inbox + QA-Thread-Label-1/2 (threadId=${threadId})`);
      }
    } catch (err) {
      log.warn(`§117 multi-recipient thread chain failed: ${err.message}`);
    }

    if (cancelled()) return;

    // ── §113 — Quality coverage per system label ───────────────────────────────
    log.info('Gmail E2E §113: quality coverage per system label…');
    const qualityScenarios = applyReadUnreadDistribution([
      // Sent
      { subject: 'QA E2E 113a-1 - Sent With PDF Attachment',            labelIds: ['SENT'],  textBody: 'Sent email with PDF attachment.', attachments: [{ filename: 'sent.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }] },
      { subject: 'QA E2E 113a-2 - Sent Multiple Attachments With CC',   labelIds: ['SENT'],  textBody: 'Sent email with 2 attachments and CC.', cc: ccEmail, attachments: [{ filename: 'sent.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 }, { filename: 'sent.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: SAMPLE_XLSX_B64 }] },
      { subject: 'QA E2E 113a-3 - Sent Flagged + High Importance',      labelIds: ['SENT', 'STARRED'], textBody: 'Sent email — flagged and high importance.', importance: 'high' },
      // Inbox (inbound)
      { subject: 'QA E2E 113b-1 - Inbox Unread With Attachment',        labelIds: ['INBOX', 'UNREAD'], textBody: 'Unread inbox email with attachment.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, attachments: [{ filename: 'inbox.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }] },
      { subject: 'QA E2E 113b-2 - Inbox High Importance Starred',       labelIds: ['INBOX', 'STARRED'], textBody: 'Starred high-importance inbox email.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail },
      { subject: 'QA E2E 113b-3 - Inbox Multiple Attachments PDF+DOCX', labelIds: ['INBOX'], textBody: 'Inbox email with PDF + DOCX attachments.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, attachments: [{ filename: 'inbox.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }, { filename: 'inbox.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 }] },
      // Spam
      { subject: 'QA E2E 113c-1 - Spam With CC Recipients',             labelIds: ['SPAM'],  textBody: 'Spam email with CC — validates Spam folder migration.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, cc: ccEmail },
      { subject: 'QA E2E 113c-2 - Spam DOCX Attachment',                labelIds: ['SPAM'],  textBody: 'Spam with attachment.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, attachments: [{ filename: 'spam.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 }] },
      // Trash
      { subject: 'QA E2E 113d-1 - Deleted With CC',                     labelIds: ['TRASH'], textBody: 'Deleted email with CC — validates Trash folder migration.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, cc: ccEmail },
      { subject: 'QA E2E 113d-2 - Deleted Multiple Attachments DOCX+XLSX', labelIds: ['TRASH'], textBody: 'Deleted email with DOCX + XLSX attachments.', mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail, attachments: [{ filename: 'trash.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 }, { filename: 'trash.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: SAMPLE_XLSX_B64 }] },
    ], 20);
    for (const s of qualityScenarios) {
      if (cancelled()) return;
      await insert({ ...s, to: s.to || toEmail });
    }
    log.info(`✓ §113 complete — ${qualityScenarios.length} quality-coverage emails`);

    if (cancelled()) return;

    // ── §114 — Shared Mailbox simulation (G→O inscope) ────────────────────────
    log.info('Gmail E2E §114: shared mailbox simulation…');
    await insert({
      subject: 'QA E2E 114 - Shared Mailbox Email Simulation',
      textBody: 'Email simulating shared mailbox content — validates Shared Mailbox migration (G→O inscope).',
      labelIds: ['INBOX'],
      mailDirection: 'incoming',
      inboundFrom: inboundSenders[0] || toEmail,
    });
    log.info('✓ §114 complete — 1 shared mailbox simulation email');

    if (cancelled()) return;

    // ── §115 — Distribution List / Group Mail (G→O inscope) ───────────────────
    log.info('Gmail E2E §115: distribution list email…');
    await insert({
      subject: 'QA E2E 115 - Distribution List Email',
      textBody: 'Email to distribution list — validates Group Mail Migration (G→O inscope).',
      labelIds: ['SENT'],
      to: toEmail,
      cc: ccEmail,
    });
    log.info('✓ §115 complete — 1 distribution list email');

    if (cancelled()) return;

    // ── §116 — HTML Signature block (Signature inscope) ───────────────────────
    log.info('Gmail E2E §116: HTML signature in body…');
    await insert({
      subject: 'QA E2E 116 - Email With HTML Signature Block',
      htmlBody: '<html><body><p>Email body content.</p><br><div class="gmail_signature"><p><b>QA Agent</b><br>CloudFuze Inc.<br>Email: qa@cloudfuze.com<br>Phone: +1-555-0100</p><img src="cid:sig-logo" alt="logo" /></div></body></html>',
      textBody: 'Email body content.\n\n--\nQA Agent\nCloudfuze Inc.',
      labelIds: ['SENT'],
    });
    log.info('✓ §116 complete — 1 HTML signature email');

    if (cancelled()) return;

    // ── §117 — Duplicate-subject test case (Sent) ────────────────────────────
    // Every seeded mail has a UNIQUE subject so subject-based pairing stays unambiguous.
    // This is the ONE deliberate exception: two Sent mails sharing an identical subject,
    // so validation can confirm the allowed same-subject pair (and flag any others).
    log.info('Gmail E2E §117: duplicate-subject Sent pair…');
    for (let i = 1; i <= 2; i++) {
      await insert({
        subject: 'QA E2E - Duplicate Subject (Sent Pair)',
        textBody: `Sent copy ${i} of a deliberately duplicated subject — validates the allowed `
          + 'same-subject pair in Sent (all other mails must have unique subjects).',
        labelIds: ['SENT'],
        to: toEmail,
      });
    }
    log.info('✓ §117 complete — duplicate-subject Sent pair');

    if (cancelled()) return;

    // ── §20/§23 — Custom folder/label emails ─────────────────────────────────
    // Mirrors OutlookTestDataAgent §11 (custom folder), §20 (work/client folders),
    // §23 (sub-level folder structure) — emails in each new label
    log.info('Gmail E2E §20/§23: custom label + sub-level label emails…');
    const labelCtx2 = await this._loadE2ELabelContext(sourceEmail, log);
    const allLabels = await gmailClient.listLabels(sourceEmail, 'me').catch(() => []);
    const findLabel = (name) => allLabels.find(l => l.name === name)?.id;

    const customLabelEmails = [
      // QA-Migration-Folder
      { label: 'QA-Migration-Folder',   subject: 'QA E2E 100 - Migration Folder Email 1',      body: 'Email in QA-Migration-Folder custom label.' },
      { label: 'QA-Migration-Folder',   subject: 'QA E2E 100 - Migration Folder Email 2',      body: 'Second email in QA-Migration-Folder custom label.' },
      // QA-Work-Projects
      { label: 'QA-Work-Projects',      subject: 'QA E2E 100 - Work Projects Email 1',          body: 'Email in QA-Work-Projects custom label.' },
      { label: 'QA-Work-Projects',      subject: 'QA E2E 100 - Work Projects Email 2',          body: 'Second email in QA-Work-Projects custom label.' },
      // QA-Client-Emails
      { label: 'QA-Client-Emails',      subject: 'QA E2E 100 - Client Emails Folder Email',     body: 'Email in QA-Client-Emails custom label.' },
      // QA-Sent-To-Custom (sent emails moved to custom — mirrors §31)
      { label: 'QA-Sent-To-Custom',     subject: 'QA E2E 104 - Sent Email In Custom Label 1',  body: 'Sent email stored in QA-Sent-To-Custom label — mirrors moved-sent scenario.', sent: true },
      { label: 'QA-Sent-To-Custom',     subject: 'QA E2E 104 - Sent Email In Custom Label 2',  body: 'Second sent email in QA-Sent-To-Custom label.', sent: true },
      // QA-Parent-With-Sub (parent folder emails — mirrors §32)
      { label: 'QA-Parent-With-Sub',    subject: 'QA E2E 105 - Parent Label Direct Email 1',   body: 'Email at parent label level — validates parent folder migration.' },
      { label: 'QA-Parent-With-Sub',    subject: 'QA E2E 105 - Parent Label Direct Email 2',   body: 'Second email at parent label level.' },
      // QA-Parent-With-Sub/QA-Child-Under-Parent (child folder emails)
      { label: 'QA-Parent-With-Sub/QA-Child-Under-Parent', subject: 'QA E2E 105 - Child Label Email 1', body: 'Email at child label level — validates sub-folder migration.' },
      { label: 'QA-Parent-With-Sub/QA-Child-Under-Parent', subject: 'QA E2E 105 - Child Label Email 2', body: 'Second email at child label level.' },
    ];
    applyReadUnreadDistribution(customLabelEmails.map(s => ({ labelIds: ['INBOX'], ...s })), 20);

    for (const s of customLabelEmails) {
      if (cancelled()) return;
      const labelId = findLabel(s.label);
      if (!labelId) { log.warn(`Label "${s.label}" not found — skipping`); continue; }
      await insert({
        subject: s.subject,
        textBody: s.body,
        labelIds: s.sent ? ['SENT', labelId] : [labelId],
        mailDirection: s.sent ? undefined : 'incoming',
        inboundFrom: s.sent ? undefined : (inboundSenders[0] || toEmail),
      });
    }

    // QA-SubLevel-Root and sub-labels (Q1–Q5 — mirrors §23)
    const subLevelDefs = [
      { label: 'QA-SubLevel-Root',              subject: 'QA E2E 102 - Root Label Email 1',        body: 'Email at root sub-level label.' },
      { label: 'QA-SubLevel-Root',              subject: 'QA E2E 102 - Root Label Email 2',        body: 'Second email at root sub-level label.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q1',   subject: 'QA E2E 102 - Q1 Plain Text Unread',      body: 'Unread email in QA-Sub-Q1.',  unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q1',   subject: 'QA E2E 102 - Q1 Plain Text Read',        body: 'Read email in QA-Sub-Q1.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q1',   subject: 'QA E2E 102 - Q1 With PDF Attachment',    body: 'PDF attachment email in QA-Sub-Q1.', attach: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q2',   subject: 'QA E2E 102 - QA-Sub-Q2 Received Unread', body: 'Unread email in QA-Sub-Q2.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q2',   subject: 'QA E2E 102 - QA-Sub-Q2 Received Read HTML', body: 'Read HTML email in QA-Sub-Q2.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q3',   subject: 'QA E2E 102 - QA-Sub-Q3 Received Unread', body: 'Unread email in QA-Sub-Q3.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q3',   subject: 'QA E2E 102 - QA-Sub-Q3 Received Read HTML', body: 'Read HTML email in QA-Sub-Q3.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q4',   subject: 'QA E2E 102 - QA-Sub-Q4 Received Unread', body: 'Unread email in QA-Sub-Q4.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q4',   subject: 'QA E2E 102 - QA-Sub-Q4 Received Read HTML', body: 'Read HTML email in QA-Sub-Q4.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q5',   subject: 'QA E2E 102 - QA-Sub-Q5 Received Unread', body: 'Unread email in QA-Sub-Q5.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q5',   subject: 'QA E2E 102 - QA-Sub-Q5 Received Read HTML', body: 'Read HTML email in QA-Sub-Q5.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q6',   subject: 'QA E2E 102 - QA-Sub-Q6 Received Unread', body: 'Unread email in QA-Sub-Q6.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q6',   subject: 'QA E2E 102 - QA-Sub-Q6 Received Read HTML', body: 'Read HTML email in QA-Sub-Q6.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q7',   subject: 'QA E2E 102 - QA-Sub-Q7 Received Unread', body: 'Unread email in QA-Sub-Q7.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q7',   subject: 'QA E2E 102 - QA-Sub-Q7 Received Read HTML', body: 'Read HTML email in QA-Sub-Q7.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q8',   subject: 'QA E2E 102 - QA-Sub-Q8 Received Unread', body: 'Unread email in QA-Sub-Q8.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q8',   subject: 'QA E2E 102 - QA-Sub-Q8 Received Read HTML', body: 'Read HTML email in QA-Sub-Q8.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q9',   subject: 'QA E2E 102 - QA-Sub-Q9 Received Unread', body: 'Unread email in QA-Sub-Q9.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q9',   subject: 'QA E2E 102 - QA-Sub-Q9 Received Read HTML', body: 'Read HTML email in QA-Sub-Q9.' },
      { label: 'QA-SubLevel-Root/QA-Sub-Q10',  subject: 'QA E2E 102 - QA-Sub-Q10 Received Unread', body: 'Unread email in QA-Sub-Q10.', unread: true },
      { label: 'QA-SubLevel-Root/QA-Sub-Q10',  subject: 'QA E2E 102 - QA-Sub-Q10 Received Read HTML', body: 'Read HTML email in QA-Sub-Q10.' },
    ];

    for (const s of subLevelDefs) {
      if (cancelled()) return;
      const labelId = findLabel(s.label);
      if (!labelId) { log.warn(`Label "${s.label}" not found — skipping`); continue; }
      const extraLabels = s.unread ? ['UNREAD', labelId] : [labelId];
      const attachments = s.attach ? [{ filename: 'sub-q1.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }] : undefined;
      await insert({
        subject: s.subject,
        textBody: s.body,
        labelIds: extraLabels,
        mailDirection: 'incoming',
        inboundFrom: inboundSenders[0] || toEmail,
        attachments,
      });
    }
    log.info(`✓ §100/§102/§104/§105 complete — custom label + sub-level emails`);

    if (cancelled()) return;

    // ── §101 — Nested label chains ─────────────────────────────────────────────
    // Chain 1: QA-TestLabel → Nested-Child → Deep-Level (existing 3-level)
    // Chain 2: QA-Deep-L1 → L2 → L3 → L4 → L5 (new 5-level deep)
    log.info('Gmail E2E §101: nested label chains…');
    const nestedChainLabels = [
      'QA-TestLabel',
      'QA-TestLabel/Nested-Child',
      'QA-TestLabel/Nested-Child/Deep-Level',
    ];
    for (let i = 0; i < nestedChainLabels.length; i++) {
      if (cancelled()) return;
      const lname   = nestedChainLabels[i];
      const labelId = findLabel(lname);
      if (!labelId) continue;
      await insert({ subject: `QA Nested-L${i + 1} Received`, textBody: `Email at nesting level ${i + 1}: "${lname}".`, labelIds: [labelId], mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail });
      await insert({ subject: `QA Nested-L${i + 1} Sent`,    textBody: `Sent email at nesting level ${i + 1}: "${lname}".`, labelIds: [labelId], mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail });
    }

    // 15-level deep chain: QA-Deep-L1 → L2 → ... → L15 (mirrors OutlookTestDataAgent §22)
    const deepChainLabels = [];
    let deepPath = '';
    for (let i = 1; i <= 15; i++) {
      deepPath = deepPath ? `${deepPath}/QA-Deep-L${i}` : `QA-Deep-L${i}`;
      deepChainLabels.push(deepPath);
    }
    for (let i = 0; i < deepChainLabels.length; i++) {
      if (cancelled()) return;
      const lname   = deepChainLabels[i];
      const labelId = findLabel(lname);
      if (!labelId) { log.warn(`Deep chain label "${lname}" not found — skipping`); continue; }
      await insert({ subject: `QA Deep-Chain-L${i + 1} Received`, textBody: `Email at deep nesting level ${i + 1}: "${lname}". Validates deep subfolder migration.`, labelIds: [labelId], mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail });
      await insert({ subject: `QA Deep-Chain-L${i + 1} Sent`,    textBody: `Sent email at deep nesting level ${i + 1}: "${lname}".`, labelIds: [labelId], mailDirection: 'incoming', inboundFrom: inboundSenders[0] || toEmail });
    }
    log.info('✓ §101 complete — 3-level + 5-level nested chain emails');

    if (cancelled()) return;

    // ── Additional thread chains — mirrors §4 (short thread) + §112 (deep) ─────
    log.info('Gmail E2E: additional thread chains…');
    // Short 3-message thread (reply chain)
    try {
      const shortSubject = 'QA E2E 4 - Thread Chain Test (3 Messages)';
      const r1 = await gmailClient.insertEmail(sourceEmail, 'me',
        gmailClient.buildRawMessage({ from: sourceEmail, to: toEmail, subject: shortSubject, textBody: 'Thread root — message 1.' }),
        ['SENT']);
      await reconcileInsertedMessageLabels(sourceEmail, { labelIds: ['SENT'] }, r1?.id, log);
      const tid3 = r1?.threadId;
      if (tid3) {
        const r2 = await gmailClient.insertEmail(sourceEmail, 'me',
          gmailClient.buildRawMessage({ from: toEmail, to: sourceEmail, subject: `Re: ${shortSubject}`, textBody: 'Reply — message 2.', inReplyTo: `<msg1@qa>` }),
          ['INBOX'], { threadId: tid3 });
        await reconcileInsertedMessageLabels(sourceEmail, { labelIds: ['INBOX'], mailDirection: 'incoming' }, r2?.id, log);
        const r3 = await gmailClient.insertEmail(sourceEmail, 'me',
          gmailClient.buildRawMessage({ from: sourceEmail, to: toEmail, subject: `Re: ${shortSubject}`, textBody: 'Final reply — message 3.', inReplyTo: `<msg2@qa>` }),
          ['SENT'], { threadId: tid3 });
        await reconcileInsertedMessageLabels(sourceEmail, { labelIds: ['SENT'] }, r3?.id, log);
        summary.emailsCreated += 3;
        log.info(`✓ Short thread chain (3 messages, threadId=${tid3})`);
      }
    } catch (err) { log.warn(`Short thread chain failed: ${err.message}`); }

    log.info('Gmail E2E extended scenarios complete');

    // Cap Inbox unread count — seeding marks many incoming mails unread; keep only a realistic few.
    // Mirrors the Outlook agent; reuses the same OUTLOOK_INBOX_MAX_UNREAD setting (mail-wide cap).
    try {
      const cap = env.OUTLOOK_INBOX_MAX_UNREAD;
      const capResult = await gmailClient.capInboxUnread(sourceEmail, cap);
      if (capResult.markedRead > 0) {
        log.info(
          `Inbox unread capped to ${cap}: ${capResult.unreadBefore} → ${capResult.unreadAfter} unread ` +
          `(${capResult.markedRead} marked read)`
        );
      }
    } catch (capErr) {
      log.warn(`Inbox unread cap failed (non-fatal): ${capErr.message}`);
    }
  }

  async _createDrafts(sourceEmail, toEmail, ccEmail, testType, summary, log, executionId) {
    const xlsxPath = env.GMAIL_TEST_CASES_XLSX || defaultGmailTestCasesXlsxPath();
    const fallbackDrafts = testType === 'SANITY'
      ? [{ subject: 'QA Sanity - Draft', textBody: 'Sanity test: draft for migration.' }]
      : [
          {
            subject: 'QA E2E - Plain draft',
            textBody: 'E2E test: draft with Cc from GOOGLE_ACCOUNTS.',
            cc: ccEmail,
          },
          {
            subject: 'QA E2E - Emoji HTML draft 📝',
            htmlBody: '<html><body><p>E2E draft with emoji in body: ✅ 🎉</p></body></html>',
            textBody: 'E2E test: another draft for QA validation.',
          },
          {
            subject: 'QA E2E - Draft with DOCX attachment',
            textBody: 'E2E: unsent draft carrying a Word document attachment (DOCX MIME).',
            attachments: [{
              filename: 'qa-draft-document.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              data: SAMPLE_DOCX_B64,
            }],
          },
        ];
    const drafts = tryLoadDraftCasesFromExcel(xlsxPath, testType, ccEmail, log) ?? fallbackDrafts;

    // Drafts use their own 1..N numbering (independent of the mail counter).
    applyRunningSubjectNumbering(drafts);

    for (const draft of drafts) {
      if (executionId && executionService.isCancelled(executionId)) {
        log.info('Draft creation cancelled by user');
        break;
      }
      try {
        const raw = gmailClient.buildRawMessage({
          to: toEmail,
          from: sourceEmail,
          cc: draft.cc,
          subject: draft.subject,
          textBody: draft.textBody,
          htmlBody: draft.htmlBody,
          attachments: draft.attachments || [],
        });
        await gmailClient.createDraft(sourceEmail, 'me', raw);
        summary.draftsCreated++;
        log.info(`Created draft: ${draft.subject}`);
      } catch (err) {
        log.error(`Failed to create draft "${draft.subject}": ${err.message}`);
      }
    }
  }

  /**
   * Seed 3–5 test contacts into the source Gmail account via the Google People API.
   * Called when context.includeContacts is true. Required for G→G and G→O contact migration QA.
   */
  async _seedContacts(sourceEmail, summary, log) {
    const contacts = [
      { displayName: 'QA Contact Alice', email: 'alice-qa@external.com', phone: '+1-555-0001', company: 'QA Corp' },
      { displayName: 'QA Contact Bob',   email: 'bob-qa@external.com',   phone: '+1-555-0002', company: 'Test Inc' },
      { displayName: 'QA Contact Carol', email: 'carol-qa@external.com', title: 'Engineer' },
      { displayName: 'QA Contact Dave',  email: 'dave-qa@external.com',  phone: '+1-555-0004', company: 'Migration Labs' },
      { displayName: 'QA Contact Eve',   email: 'eve-qa@external.com',   phone: '+1-555-0005', company: 'CloudFuze QA', title: 'QA Lead' },
    ];

    log.info(`Gmail contacts seed: creating ${contacts.length} QA contacts for ${sourceEmail}`);
    for (const contact of contacts) {
      try {
        await gmailClient.createGmailContact(sourceEmail, contact);
        summary.contactsCreated++;
        log.info(`Created contact: ${contact.displayName} <${contact.email || ''}>`);
      } catch (err) {
        log.error(`Failed to create contact "${contact.displayName}": ${err.message}`);
      }
    }
  }

  /**
   * Seed Gmail filter rules for the E2E run.
   * Feature: Filters/rules (G→O inscope). Validates that Gmail filter definitions are
   * migrated to Outlook rules.
   * Uses the Gmail Settings Filters API (users.settings.filters.create).
   * Requires gmail.settings.basic scope in DWD.
   *
   * For each filter we also seed matching inbound emails placed DIRECTLY in the
   * filter's target label (INBOX removed) — simulating what the filter would do
   * when a real email arrives. This mirrors OutlookTestDataAgent §24/§41/§43
   * inbox-rule test data.
   */
  async _seedGmailFilters(sourceEmail, log, opts = {}) {
    // Resolve label names → IDs
    let labelMap = {};
    try {
      const labels = await gmailClient.listLabels(sourceEmail, 'me');
      for (const l of labels) labelMap[l.name] = l.id;
    } catch (e) {
      log.warn(`Gmail filter seed: could not list labels: ${e.message}`);
    }

    const getId = (name) => labelMap[name] || null;

    // Rules key on REAL users from this run's resolved correspondents (internal like ben@…, or the
    // external test users mia/sophia), NOT fake placeholder addresses. A "from:<user>" rule routes
    // mail from that real user into its label (skip Inbox); normal mail from non-ruled users still
    // lands in Inbox (seeded separately). Exclude the source itself so mail is never self-addressed.
    const realSenders = (opts.inboundSenders || [])
      .filter((e) => e && String(e).toLowerCase() !== String(sourceEmail).toLowerCase());
    const pickSender = (i) => (realSenders.length
      ? realSenders[i % realSenders.length]
      : FALLBACK_EXTERNAL_CORRESPONDENTS[i % FALLBACK_EXTERNAL_CORRESPONDENTS.length]);
    const senderFrom     = pickSender(0);   // e.g. ben@migrationn.com
    const senderAttach   = pickSender(1);   // another real user
    const senderCombined = pickSender(2);   // another real user
    const senderSize     = pickSender(3);   // another real user (size rule)
    log.info(`Gmail filter seed: rule senders — from:${senderFrom}, attach:${senderAttach}, combined:${senderCombined}, size:${senderSize}`);

    // ── Filter definitions ────────────────────────────────────────────────────
    // Each filter: criteria (real user / subject) → action (add label + skip inbox) + matching mail.
    const filters = [
      {
        description: `Filter 1: From ${senderFrom} → QA-Filter-From-Sender (skip Inbox)`,
        criteria: { from: senderFrom },
        targetLabel: 'QA-Filter-From-Sender',
        skipInbox: true,
        markAsRead: false,
        testEmails: [
          { subject: 'QA Gmail Filter - From Sender Rule #1',         body: `Filter test: email from ${senderFrom} — routed by rule to QA-Filter-From-Sender, not Inbox.` },
          { subject: 'QA Gmail Filter - From Sender Rule #2 (HTML)',  body: `Filter test 2 from ${senderFrom} — HTML email routed by from-sender rule.`, html: true },
          { subject: 'QA Gmail Filter - From Sender Rule #3 + Attach',body: `Filter test 3 from ${senderFrom} — with attachment, routed by from-sender rule.`, attach: true },
        ],
      },
      {
        description: 'Filter 2: Subject contains [QA-Filter-Test] → QA-Filter-Subject-Keyword (skip Inbox, mark read)',
        criteria: { subject: '[QA-Filter-Test]' },
        targetLabel: 'QA-Filter-Subject-Keyword',
        skipInbox: true,
        markAsRead: true,
        testEmails: [
          { subject: '[QA-Filter-Test] Subject Keyword Rule #1',      body: 'Filter test: subject keyword [QA-Filter-Test] — routed to QA-Filter-Subject-Keyword, marked as read.' },
          { subject: '[QA-Filter-Test] Subject Keyword Rule #2',      body: 'Filter test 2: another email matching subject keyword filter.' },
        ],
      },
      {
        description: `Filter 3: From ${senderAttach} + has attachment → QA-Filter-Has-Attachment (skip Inbox)`,
        criteria: { hasAttachment: true, from: senderAttach },
        targetLabel: 'QA-Filter-Has-Attachment',
        skipInbox: true,
        markAsRead: false,
        testEmails: [
          { subject: 'QA Gmail Filter - Has Attachment Rule #1',      body: `Filter test: email from ${senderAttach} with attachment — routed to QA-Filter-Has-Attachment.`, attach: true },
          { subject: 'QA Gmail Filter - Has Attachment Rule #2 DOCX', body: `Filter test 2 from ${senderAttach}: DOCX attachment routed to custom label.`, attachDocx: true },
        ],
      },
      {
        description: `Filter 4: Combined (from ${senderCombined} + subject [QA-Combined]) → QA-Filter-Combined (skip Inbox)`,
        criteria: { from: senderCombined, subject: '[QA-Combined]' },
        targetLabel: 'QA-Filter-Combined',
        skipInbox: true,
        markAsRead: false,
        testEmails: [
          { subject: '[QA-Combined] Combined Filter Rule #1',         body: `Combined filter: from ${senderCombined} + subject [QA-Combined] — routed to QA-Filter-Combined.` },
          { subject: '[QA-Combined] Combined Filter Rule #2 + Attach',body: `Combined filter test 2 from ${senderCombined} with attachment.`, attach: true },
        ],
      },
      {
        description: `Filter 5: From ${senderSize} + has attachment larger than 10 MB → QA-Filter-Size (skip Inbox)`,
        criteria: { from: senderSize, hasAttachment: true, size: 10 * 1024 * 1024, sizeComparison: 'larger' },
        targetLabel: 'QA-Filter-Size',
        skipInbox: true,
        markAsRead: false,
        testEmails: [
          { subject: 'QA Gmail Filter - Size Rule #1 (>10MB attachment)', body: `Filter test: email from ${senderSize} with a large attachment — matches the size rule (larger than 10 MB), routed to QA-Filter-Size.`, attachLarge: true },
        ],
      },
    ];

    let filtersCreated = 0;
    let emailsSeeded  = 0;

    for (const f of filters) {
      const labelId = getId(f.targetLabel);

      // ── Create the filter rule ──────────────────────────────────────────────
      try {
        const addLabelIds    = labelId ? [labelId] : [];
        const removeLabelIds = f.skipInbox ? ['INBOX'] : [];
        if (f.markAsRead) removeLabelIds.push('UNREAD');

        const criteria = { ...f.criteria };
        await gmailClient.createGmailFilter(sourceEmail, criteria, { addLabelIds, removeLabelIds });
        filtersCreated++;
        log.info(`Gmail filter seed: created — ${f.description}`);
      } catch (err) {
        log.warn(`Gmail filter seed: could not create filter (${f.description}): ${err.message}`);
      }

      // ── Seed matching test emails directly in the target label ──────────────
      // We insert them with the target label (no INBOX) to simulate what the
      // filter would do when a real email arrives from the matching sender/subject.
      if (!labelId) {
        log.warn(`Gmail filter seed: label "${f.targetLabel}" not found — skipping email seeding for this filter`);
        continue;
      }

      for (const em of f.testEmails) {
        try {
          const htmlBody = em.html
            ? `<html><body><h2>${em.subject}</h2><p>${em.body}</p><p><b>Filter routed</b> — Gmail filter rule applied.</p></body></html>`
            : undefined;
          const attachments = em.attach
            ? [{ filename: 'filter-test.pdf', mimeType: 'application/pdf', data: SAMPLE_MINIMAL_PDF_B64 }]
            : em.attachDocx
            ? [{ filename: 'filter-test.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: SAMPLE_DOCX_B64 }]
            : em.attachLarge
            // Sizable real attachment for the size-rule test. Kept at 2 MB so messages.insert (simple
            // upload) succeeds; the mail is inserted straight into the label, so placement validates
            // regardless — the size RULE itself carries the real "larger than 10 MB" criteria.
            ? [{ filename: 'filter-large-attachment.bin', mimeType: 'application/octet-stream', data: SAMPLE_2M_B64 }]
            : undefined;

          const senderEmail = f.criteria.from || FALLBACK_EXTERNAL_CORRESPONDENTS[0];
          const raw = gmailClient.buildRawMessage({
            from: senderEmail,
            to: sourceEmail,
            subject: em.subject,
            textBody: em.body,
            htmlBody,
            attachments,
          });

          // Place ONLY in the filter's target label — NO INBOX (filter skips inbox)
          const labelIds = f.markAsRead ? [labelId] : [labelId, 'UNREAD'];
          const data = await gmailClient.insertEmail(sourceEmail, 'me', raw, labelIds);
          emailsSeeded++;
          log.info(`Gmail filter seed: seeded email "${em.subject}" → ${f.targetLabel}`);
        } catch (err) {
          log.warn(`Gmail filter seed: could not seed email "${em.subject}": ${err.message}`);
        }
      }
    }

    log.info(`Gmail filter seed complete: ${filtersCreated} filter(s) created, ${emailsSeeded} matching email(s) seeded directly in filter target labels`);
  }

  /**
   * Seed a Google Contacts contact group (label) and assign at least one QA contact to it.
   * Feature: Contact labels (G→O inscope). Validates that Google contact groups migrate to
   * Outlook contact categories.
   * Non-fatal: People API contactGroups may not be available on all account types.
   */
  async _seedContactGroup(sourceEmail, log) {
    const GROUP_NAME = 'QA-Contact-Group';
    let groupResourceName = null;
    try {
      const group = await gmailClient.createContactGroup(sourceEmail, GROUP_NAME);
      groupResourceName = group.resourceName || group.contactGroup?.resourceName;
      log.info(`Gmail contact label seed: created contact group "${GROUP_NAME}" (${groupResourceName}) — G→O inscope: Contact labels migration`);
    } catch (err) {
      log.warn(`Gmail contact label seed: could not create contact group "${GROUP_NAME}": ${err.message} — contact label seeding skipped`);
      return;
    }

    if (!groupResourceName) {
      log.warn(`Gmail contact label seed: no resourceName returned for group "${GROUP_NAME}" — skipping member add`);
      return;
    }

    // Seed a labelled contact and add it to the group
    const labeledContact = { displayName: 'QA Contact Labeled', email: 'qa-labeled@external-qa.com', company: 'CloudFuze QA', title: 'Labeled Contact' };
    let personResourceName = null;
    try {
      const person = await gmailClient.createGmailContact(sourceEmail, labeledContact);
      personResourceName = person.resourceName;
      log.info(`Gmail contact label seed: created labeled contact "${labeledContact.displayName}" (${personResourceName})`);
    } catch (err) {
      log.warn(`Gmail contact label seed: could not create labeled contact: ${err.message}`);
    }

    if (personResourceName) {
      try {
        await gmailClient.addContactsToGroup(sourceEmail, groupResourceName, [personResourceName]);
        log.info(`Gmail contact label seed: assigned "${labeledContact.displayName}" to group "${GROUP_NAME}" — validates G→O contact label migration`);
      } catch (err) {
        log.warn(`Gmail contact label seed: could not assign contact to group: ${err.message}`);
      }
    }
  }

  _withOptionalAttendee(eventBase, attendeeEmail, sourceEmail) {
    if (!attendeeEmail || attendeeEmail.toLowerCase() === String(sourceEmail).toLowerCase()) {
      return eventBase;
    }
    return {
      ...eventBase,
      attendees: [{ email: attendeeEmail }],
    };
  }

  async _createCalendarEvents(sourceEmail, attendeeEmail, summary, log) {
    try {
      const calRes = await calendarClient.createCalendar(sourceEmail, 'QA Secondary Calendar');
      const secondaryCalId = calRes.data.id;
      log.info(`Created secondary calendar: ${secondaryCalId} (mailbox: ${sourceEmail})`);

      const now = Date.now();
      const events = [
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Single Event',
              description: 'E2E test: single event for migration QA',
              start: { dateTime: new Date(now + 86400000).toISOString(), timeZone: 'UTC' },
              end: { dateTime: new Date(now + 90000000).toISOString(), timeZone: 'UTC' },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - All Day Event',
              description: 'E2E test: all-day event',
              start: { date: new Date(now + 259200000).toISOString().split('T')[0] },
              end: { date: new Date(now + 345600000).toISOString().split('T')[0] },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: secondaryCalId,
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Secondary Calendar Event',
              description: 'E2E test: event on secondary calendar',
              start: { dateTime: new Date(now + 432000000).toISOString(), timeZone: 'UTC' },
              end: { dateTime: new Date(now + 435600000).toISOString(), timeZone: 'UTC' },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: 'primary',
          event: this._withOptionalAttendee(
            {
              summary: 'QA E2E - Eastern Time Zone Event',
              description: 'E2E test: event with non-UTC timezone (America/New_York) — validates timezone preservation across migration.',
              start: { dateTime: new Date(now + 691200000).toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'America/New_York' },
              end: { dateTime: new Date(now + 698400000).toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'America/New_York' },
            },
            attendeeEmail,
            sourceEmail
          ),
        },
        {
          calendarId: 'primary',
          event: {
            summary: 'QA E2E - RSVP Attendee Event',
            description: 'E2E test: event with attendees and RSVP status — organizer accepted, external attendee needs action.',
            start: { dateTime: new Date(now + 777600000).toISOString(), timeZone: 'UTC' },
            end: { dateTime: new Date(now + 781200000).toISOString(), timeZone: 'UTC' },
            attendees: [
              { email: sourceEmail, responseStatus: 'accepted', self: true, organizer: true },
              ...(attendeeEmail && attendeeEmail.toLowerCase() !== sourceEmail.toLowerCase()
                ? [{ email: attendeeEmail, responseStatus: 'needsAction' }]
                : [{ email: 'qa-attendee@external-qa.com', responseStatus: 'needsAction' }]),
            ],
          },
        },
        {
          calendarId: 'primary',
          event: {
            summary: 'QA E2E - Google Meet Conference Event',
            description: 'E2E test: event with Google Meet conference link — validates conferencing data migration.',
            start: { dateTime: new Date(now + 864000000).toISOString(), timeZone: 'UTC' },
            end: { dateTime: new Date(now + 867600000).toISOString(), timeZone: 'UTC' },
            conferenceData: {
              createRequest: {
                requestId: `qa-meet-${Date.now()}`,
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            },
          },
          opts: { conferenceDataVersion: 1 },
        },
      ];

      // ── §25 — Calendar Meeting Rooms (inscope) ────────────────────────────────
      // Google Calendar room resources are identified by their resource email.
      // We add a room-like attendee (resource type) to simulate a meeting room booking.
      // Without admin-provisioned rooms, we use a placeholder resource email.
      events.push({
        calendarId: 'primary',
        event: {
          summary: 'QA E2E - Calendar Meeting Room Event',
          description: 'E2E test: event with a meeting room resource attendee — validates calendar meeting room migration (inscope for G→O).',
          start: { dateTime: new Date(now + 950400000).toISOString(), timeZone: 'UTC' },
          end:   { dateTime: new Date(now + 954000000).toISOString(), timeZone: 'UTC' },
          location: 'QA Conference Room A, CloudFuze HQ',
          attendees: [
            { email: sourceEmail, responseStatus: 'accepted', self: true, organizer: true },
            ...(attendeeEmail && attendeeEmail.toLowerCase() !== sourceEmail.toLowerCase()
              ? [{ email: attendeeEmail, responseStatus: 'accepted' }]
              : []),
            {
              email: 'qa-room-resource@resource.calendar.google.com',
              displayName: 'QA Conference Room A',
              resource: true,
              responseStatus: 'accepted',
            },
          ],
        },
      });

      // ── §26 — Calendar Notes (inscope) ────────────────────────────────────────
      // Google Calendar "notes" are events with no time (all-day) or events where
      // the description carries rich note content. We create two note-style events:
      // one all-day note and one timed event with extensive description notes.
      events.push(
        {
          calendarId: 'primary',
          event: {
            summary: 'QA E2E - Calendar Note (All Day)',
            description: 'E2E test: calendar note seeded as an all-day event with rich description.\n\n' +
              'Notes content:\n• Action item 1: Review migration report\n• Action item 2: Validate folder mapping\n• Action item 3: Check attachment integrity\n\n' +
              'This validates that Google Calendar note-style events migrate correctly to Outlook (inscope for G→O).',
            start: { date: new Date(now + 1036800000).toISOString().split('T')[0] },
            end:   { date: new Date(now + 1123200000).toISOString().split('T')[0] },
          },
        },
        {
          calendarId: 'primary',
          event: {
            summary: 'QA E2E - Calendar Note (Timed with Rich Notes)',
            description: 'E2E test: timed calendar event used as a note with detailed content.\n\n' +
              '== Meeting Notes ==\n' +
              'Attendees: QA Team, CloudFuze Migration Team\n' +
              'Agenda:\n  1. Migration status review\n  2. Bug triage\n  3. Next sprint planning\n\n' +
              'Decisions:\n  - Increase E2E test coverage for G→O\n  - Fix folder mapping edge cases\n\n' +
              'Action Items:\n  [QA] Validate archived email migration by EOD\n  [Dev] Fix CSV upload 401 on devemail',
            start: { dateTime: new Date(now + 1209600000).toISOString(), timeZone: 'UTC' },
            end:   { dateTime: new Date(now + 1213200000).toISOString(), timeZone: 'UTC' },
          },
        }
      );

      for (const { calendarId, event, opts } of events) {
        try {
          await calendarClient.createEvent(sourceEmail, calendarId, event, { sendUpdates: 'none', ...opts });
          summary.eventsCreated++;
          log.info(`Created event: ${event.summary} on ${calendarId}`);
        } catch (err) {
          log.error(`Failed to create event "${event.summary}": ${err.message}`);
        }
      }

      // ── Recurring weekly event + single-instance exception ───────────────────
      // Create a base recurring event, then patch the second occurrence to modify
      // its summary and description (tests recurring exception migration).
      let recurringBaseId = null;
      try {
        const recurStart = new Date(now + 172800000);
        const recurEnd   = new Date(now + 176400000);
        const recurRes   = await calendarClient.createEvent(
          sourceEmail, 'primary',
          this._withOptionalAttendee(
            {
              summary: 'QA E2E - Recurring Weekly Event',
              description: 'E2E test: recurring weekly event (4 occurrences). Second occurrence will be modified as exception.',
              start: { dateTime: recurStart.toISOString(), timeZone: 'UTC' },
              end:   { dateTime: recurEnd.toISOString(),   timeZone: 'UTC' },
              recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
            },
            attendeeEmail,
            sourceEmail
          ),
          { sendUpdates: 'none' }
        );
        recurringBaseId = recurRes?.data?.id;
        summary.eventsCreated++;
        log.info(`Created recurring event: QA E2E - Recurring Weekly Event (id=${recurringBaseId})`);
      } catch (err) {
        log.error(`Failed to create recurring event: ${err.message}`);
      }

      if (recurringBaseId) {
        try {
          const instances = await calendarClient.listInstances(sourceEmail, 'primary', recurringBaseId, 5);
          const secondInstance = instances[1] || instances[0];
          if (secondInstance?.id) {
            await calendarClient.patchEvent(sourceEmail, 'primary', secondInstance.id, {
              summary: 'QA E2E - Recurring Weekly Event (Exception: occurrence modified)',
              description: 'Exception occurrence: this instance was individually modified from the recurring series — tests migration of recurring event exceptions.',
            });
            log.info(`Patched recurring exception on occurrence id=${secondInstance.id}`);
          } else {
            log.warn('Recurring exception: no second instance found — patch skipped');
          }
        } catch (err) {
          log.warn(`Recurring exception patch failed (non-fatal): ${err.message}`);
        }
      }

      // ── Calendar invitation email (DELTA inscope) ─────────────────────────────
      // Create an event WITH guest(s) + a Google Meet link and sendUpdates:'all' so Google actually
      // EMAILS the invitation (carrying invite.ics) to the guests — mirroring a real Calendar invite.
      // Runs only in DELTA (this whole method is gated on context.includeCalendar === DELTA-only).
      // Falls back to a no-Meet invite if conference (Meet) creation is not permitted on the account.
      if (attendeeEmail && attendeeEmail.toLowerCase() !== String(sourceEmail).toLowerCase()) {
        const invStart = new Date(now + 259200000); // +3 days
        const invEnd   = new Date(now + 262800000); // +1h
        const invEvent = {
          summary: 'QA Delta - Calendar Invitation (Meet + Guests)',
          description: 'E2E DELTA test: calendar invitation with a Google Meet link and guest(s). '
            + 'Created with sendUpdates=all so Google sends the invitation email (with invite.ics) to the guest(s).',
          location: 'Google Meet',
          start: { dateTime: invStart.toISOString(), timeZone: 'UTC' },
          end:   { dateTime: invEnd.toISOString(),   timeZone: 'UTC' },
          attendees: [{ email: attendeeEmail }],
          reminders: { useDefault: true },
          conferenceData: {
            createRequest: {
              requestId: `qa-meet-${now}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        };
        try {
          await calendarClient.createEvent(sourceEmail, 'primary', invEvent, { sendUpdates: 'all', conferenceDataVersion: 1 });
          summary.eventsCreated++;
          log.info(`Created calendar invitation (Meet + guest ${attendeeEmail}) — invitation email triggered`);
        } catch (meetErr) {
          log.warn(`Calendar invitation with Meet failed (${meetErr.message}) — retrying without Meet`);
          const noMeet = { ...invEvent };
          delete noMeet.conferenceData;
          try {
            await calendarClient.createEvent(sourceEmail, 'primary', noMeet, { sendUpdates: 'all' });
            summary.eventsCreated++;
            log.info(`Created calendar invitation (guest ${attendeeEmail}, no Meet) — invitation email triggered`);
          } catch (invErr) {
            log.error(`Failed to create calendar invitation event: ${invErr.message}`);
          }
        }
      }
    } catch (err) {
      log.error(`Failed to create calendar events: ${err.message}`);
    }
  }
}

module.exports = GmailTestDataAgent;
