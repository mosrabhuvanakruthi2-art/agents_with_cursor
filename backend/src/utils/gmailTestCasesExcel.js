const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const gmailClient = require('../clients/gmailClient');

const SHEET_MAIL = 'Mail';
const SHEET_DRAFTS = 'Drafts';

function normHeader(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function truthyCell(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'x';
}

function parseLabelIds(cell) {
  return String(cell ?? '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * GmailTestDataAgent inserts outgoing MIME (From: source → To: correspondent).
 * Legacy sheets used INBOX — that wrongly placed “sent” mail in Inbox and Sent.
 * Replace system label INBOX with SENT for seeded mail rows.
 */
function normalizeOutgoingSeedLabelIds(labelIds) {
  return (labelIds || []).map((id) =>
    String(id || '').trim().toUpperCase() === 'INBOX' ? 'SENT' : id
  );
}

/**
 * Normalize sheet_to_json rows so keys are lowercase-no-space (e.g. labelids, testtype).
 */
function normalizeRows(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[normHeader(k)] = v;
    }
    return out;
  });
}

function defaultInlineHtml(reactionNote) {
  return `<html><body>
          <h1>Inline Image Test 👍</h1>
          ${reactionNote}
          <p>Emoji in body: ❤️ 😀 🎉</p>
          <p>Below is an inline image:</p>
          <img src="cid:inline-image-001" alt="test image" />
        </body></html>`;
}

/**
 * Build one message definition from an Excel row (normalized keys).
 */
function rowToMailDef(row, { qaIds, snoozeId, ccEmail, bccEmail, sourceEmail, samples, log }) {
  const subject = String(row.subject ?? '').trim();
  if (!subject) return null;

  // Snoozed-label test case removed from all combinations: a Gmail snooze has no destination
  // equivalent and is never migrated, so the scenario is not seeded.
  if (truthyCell(row.postsnooze) || /snooz/i.test(subject)) return null;

  const incoming = truthyCell(row.incoming);

  let labelIds = parseLabelIds(row.labelids);
  const userLabel = String(row.userlabel ?? '').trim();

  if (truthyCell(row.skipinbox)) {
    if (!userLabel) {
      log.warn(`Excel mail row "${subject}": SkipInbox=Y requires UserLabel`);
      return null;
    }
    const sid = qaIds[userLabel];
    if (!sid) {
      log.warn(`Excel mail row "${subject}": SkipInbox=Y but userLabel "${userLabel}" not resolved`);
      return null;
    }
    labelIds = [sid];
  } else if (userLabel) {
    const id = qaIds[userLabel];
    if (id) {
      if (!labelIds.length) labelIds = incoming ? ['INBOX'] : ['SENT'];
      labelIds = [...labelIds, id];
    } else {
      log.warn(`Excel mail row "${subject}": userLabel "${userLabel}" not found — skipping row`);
      return null;
    }
  }
  if (!labelIds.length) labelIds = incoming ? ['INBOX'] : ['SENT'];

  const textBody = row.textbody != null && String(row.textbody).length ? String(row.textbody) : undefined;
  let htmlBody = row.htmlbody != null && String(row.htmlbody).trim().length ? String(row.htmlbody) : undefined;

  const def = {
    subject,
    textBody,
    htmlBody,
    labelIds,
  };

  if (truthyCell(row.cc) && ccEmail) def.cc = ccEmail;
  /**
   * Bcc resolution: prefer a distinct GOOGLE_ACCOUNTS user (bccEmail, picked to be different
   * from sender/To/Cc) so the source mailbox doesn't show peter@… in its own Bcc. Falls back
   * to ccEmail and finally to sourceEmail (self-Bcc) only when no other account is available.
   * BccSelf=Y in the sheet no longer forces the sender; it is treated as "please set a Bcc"
   * and the distinct account is used when present — this avoids the UI showing bcc:me on seeds.
   */
  const bccDistinct = String(bccEmail || '').trim();
  const selfRequested = truthyCell(row.bccself);
  const anyBccRequested = selfRequested || truthyCell(row.bcc);
  if (anyBccRequested) {
    if (bccDistinct) {
      def.bcc = bccDistinct;
    } else if (ccEmail) {
      def.bcc = ccEmail;
    } else if (sourceEmail) {
      def.bcc = String(sourceEmail).trim();
    }
  }

  if (truthyCell(row.multiattachment)) {
    def.attachments = [
      {
        filename: 'qa-first.txt',
        mimeType: 'text/plain',
        data: samples.attachmentData,
      },
      {
        filename: 'qa-second.txt',
        mimeType: 'text/plain',
        data: samples.secondAttachmentData || samples.attachmentData,
      },
    ];
  } else if (truthyCell(row.attachment)) {
    def.attachments = [
      {
        filename: 'test-document.txt',
        mimeType: 'text/plain',
        data: samples.attachmentData,
      },
    ];
  }

  const attachmentExtras = [];
  if (truthyCell(row.attachpdf) && samples.minimalPdfData) {
    attachmentExtras.push({
      filename: 'qa-onepage.pdf',
      mimeType: 'application/pdf',
      data: samples.minimalPdfData,
    });
  }
  if (truthyCell(row.largeattach) && samples.largeAttachmentData) {
    attachmentExtras.push({
      filename: 'qa-large.bin',
      mimeType: 'application/octet-stream',
      data: samples.largeAttachmentData,
    });
  }
  if (truthyCell(row.attach1k) && samples.small1kData) {
    attachmentExtras.push({
      filename: 'qa-1k.bin',
      mimeType: 'application/octet-stream',
      data: samples.small1kData,
    });
  }
  if (truthyCell(row.attach100k) && samples.medium100kData) {
    attachmentExtras.push({
      filename: 'qa-100k.bin',
      mimeType: 'application/octet-stream',
      data: samples.medium100kData,
    });
  }
  if (truthyCell(row.attach512k) && samples.xlarge512kData) {
    attachmentExtras.push({
      filename: 'qa-512k.bin',
      mimeType: 'application/octet-stream',
      data: samples.xlarge512kData,
    });
  }
  if (truthyCell(row.attachjpeg) && samples.jpegAttachmentData) {
    attachmentExtras.push({
      filename: 'qa-sample.jpg',
      mimeType: 'image/jpeg',
      data: samples.jpegAttachmentData,
    });
  }
  if (truthyCell(row.attachpng) && samples.pngAttachmentData) {
    attachmentExtras.push({
      filename: 'qa-sample.png',
      mimeType: 'image/png',
      data: samples.pngAttachmentData,
    });
  }
  if (truthyCell(row.attachzip) && samples.zipAttachmentData) {
    attachmentExtras.push({
      filename: 'qa-sample.zip',
      mimeType: 'application/zip',
      data: samples.zipAttachmentData,
    });
  }
  if (truthyCell(row.attach2m) && samples.huge2mData) {
    attachmentExtras.push({
      filename: 'qa-2mb.bin',
      mimeType: 'application/octet-stream',
      data: samples.huge2mData,
    });
  }
  if (truthyCell(row.attachcsv) && samples.csvAttachmentData) {
    attachmentExtras.push({
      filename: 'qa-report.csv',
      mimeType: 'text/csv',
      data: samples.csvAttachmentData,
    });
  }
  if (attachmentExtras.length) {
    def.attachments = [...(def.attachments || []), ...attachmentExtras];
  }

  if (truthyCell(row.inlineimage)) {
    def.inlineImages = [
      {
        contentId: 'inline-image-001',
        mimeType: 'image/png',
        data: samples.inlineImageData,
      },
    ];
    if (!def.htmlBody) {
      const note =
        '<p style="color:#666"><i>Gmail UI reactions are not set via API; emoji exercises Unicode in migration.</i></p>';
      def.htmlBody = defaultInlineHtml(note);
    }
    if (!def.textBody) def.textBody = 'Inline + emoji fallback';
  }

  if (!def.textBody && !def.htmlBody) {
    def.textBody = '(no body)';
  }

  if (incoming) {
    def.mailDirection = 'incoming';
    def.labelIds = (def.labelIds || []).map((id) => (String(id).toUpperCase() === 'SENT' ? 'INBOX' : id));
    if (!def.labelIds.length) def.labelIds = ['INBOX'];
  } else {
    def.labelIds = normalizeOutgoingSeedLabelIds(def.labelIds);
  }

  return def;
}

function rowToDraftDef(row, ccEmail) {
  const subject = String(row.subject ?? '').trim();
  if (!subject) return null;
  const textBody =
    row.textbody != null && String(row.textbody).length ? String(row.textbody) : undefined;
  const htmlBody =
    row.htmlbody != null && String(row.htmlbody).trim().length ? String(row.htmlbody) : undefined;
  const draft = { subject, textBody, htmlBody };
  if (truthyCell(row.cc) && ccEmail) draft.cc = ccEmail;
  if (!draft.textBody && !draft.htmlBody) draft.textBody = '(no body)';
  return draft;
}

/**
 * @param {string} filePath absolute or cwd-relative path to .xlsx
 * @param {'SMOKE'|'SANITY'|'E2E'} testType
 * @param {{ qaIds: Record<string,string>, snoozeId: string|null, ccEmail: string, bccEmail?: string, sourceEmail?: string, samples: { attachmentData: string, inlineImageData: string }, log: import('winston').Logger }} ctx
 * @returns {object[]|null} message defs, or null if file/sheet missing
 */
function tryLoadMailCasesFromExcel(filePath, testType, ctx) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;

  let wb;
  try {
    wb = XLSX.readFile(resolved, { cellDates: false });
  } catch (e) {
    ctx.log.error(`gmail-test-cases: failed to read ${resolved}: ${e.message}`);
    return null;
  }

  const sheet = wb.Sheets[SHEET_MAIL];
  if (!sheet) {
    ctx.log.warn(`gmail-test-cases: sheet "${SHEET_MAIL}" not found in ${resolved}`);
    return null;
  }

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rows = normalizeRows(raw);
  const want = String(testType || '').toUpperCase();
  // Smoke and Sanity are merged — a SANITY run includes rows tagged either SMOKE or SANITY.
  const wanted = want === 'SANITY' ? new Set(['SMOKE', 'SANITY']) : new Set([want]);
  const defs = [];
  for (const row of rows) {
    const tt = String(row.testtype ?? '').toUpperCase().trim();
    if (!wanted.has(tt)) continue;
    const en = row.enabled;
    if (en !== undefined && en !== null && String(en).trim() !== '') {
      if (!truthyCell(en)) continue;
    }

    const def = rowToMailDef(row, ctx);
    if (def) defs.push(def);
  }

  if (!defs.length) {
    ctx.log.warn(`gmail-test-cases: no enabled "${want}" rows in ${SHEET_MAIL} — using code fallback`);
    return null;
  }

  ctx.log.info(`Loaded ${defs.length} mail case(s) from ${resolved} [${SHEET_MAIL} / ${want}]`);
  return defs;
}

/**
 * @returns {object[]|null}
 */
function tryLoadDraftCasesFromExcel(filePath, testType, ccEmail, log) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;

  let wb;
  try {
    wb = XLSX.readFile(resolved, { cellDates: false });
  } catch (e) {
    log.error(`gmail-test-cases: failed to read ${resolved}: ${e.message}`);
    return null;
  }

  const sheet = wb.Sheets[SHEET_DRAFTS];
  if (!sheet) return null;

  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rows = normalizeRows(raw);
  const want = String(testType || '').toUpperCase();
  // Smoke and Sanity are merged — a SANITY run includes rows tagged either SMOKE or SANITY.
  const wanted = want === 'SANITY' ? new Set(['SMOKE', 'SANITY']) : new Set([want]);
  const defs = [];
  for (const row of rows) {
    const tt = String(row.testtype ?? '').toUpperCase().trim();
    if (!wanted.has(tt)) continue;
    const en = row.enabled;
    if (en !== undefined && en !== null && String(en).trim() !== '') {
      if (!truthyCell(en)) continue;
    }
    const def = rowToDraftDef(row, ccEmail);
    if (def) defs.push(def);
  }

  if (!defs.length) return null;
  log.info(`Loaded ${defs.length} draft case(s) from ${resolved} [${SHEET_DRAFTS} / ${want}]`);
  return defs;
}

function defaultGmailTestCasesXlsxPath() {
  return path.join(__dirname, '../../data/gmail-test-cases.xlsx');
}

module.exports = {
  tryLoadMailCasesFromExcel,
  tryLoadDraftCasesFromExcel,
  defaultGmailTestCasesXlsxPath,
  normalizeOutgoingSeedLabelIds,
  SHEET_MAIL,
  SHEET_DRAFTS,
};
