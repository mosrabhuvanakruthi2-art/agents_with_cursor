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
function rowToMailDef(row, { qaIds, snoozeId, ccEmail, samples, log }) {
  const subject = String(row.subject ?? '').trim();
  if (!subject) return null;

  let labelIds = parseLabelIds(row.labelids);
  const userLabel = String(row.userlabel ?? '').trim();
  if (userLabel) {
    const id = qaIds[userLabel];
    if (id) {
      if (!labelIds.length) labelIds = ['INBOX'];
      labelIds = [...labelIds, id];
    } else {
      log.warn(`Excel mail row "${subject}": userLabel "${userLabel}" not found — skipping row`);
      return null;
    }
  }
  if (!labelIds.length) labelIds = ['INBOX'];

  const textBody = row.textbody != null && String(row.textbody).length ? String(row.textbody) : undefined;
  let htmlBody = row.htmlbody != null && String(row.htmlbody).trim().length ? String(row.htmlbody) : undefined;

  const def = {
    subject,
    textBody,
    htmlBody,
    labelIds,
  };

  if (truthyCell(row.cc) && ccEmail) def.cc = ccEmail;

  if (truthyCell(row.attachment)) {
    def.attachments = [
      {
        filename: 'test-document.txt',
        mimeType: 'text/plain',
        data: samples.attachmentData,
      },
    ];
  }

  if (truthyCell(row.inlineimage)) {
    def.inlineImages = [
      {
        contentId: 'inline-image-001',
        mimeType: 'image/gif',
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

  if (truthyCell(row.postsnooze) && snoozeId) {
    def.postInsert = async (src, msgId, lg) => {
      await gmailClient.modifyMessageLabels(src, 'me', msgId, [snoozeId], []);
      lg.info(`Applied Snoozed label to message ${msgId}`);
    };
  } else if (truthyCell(row.postsnooze) && !snoozeId) {
    log.warn(`Excel mail row "${subject}": PostSnooze=Y but no Snooze label — post-insert skipped`);
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
 * @param {{ qaIds: Record<string,string>, snoozeId: string|null, ccEmail: string, samples: { attachmentData: string, inlineImageData: string }, log: import('winston').Logger }} ctx
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
  const defs = [];
  for (const row of rows) {
    const tt = String(row.testtype ?? '').toUpperCase().trim();
    if (tt !== want) continue;
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
  const defs = [];
  for (const row of rows) {
    const tt = String(row.testtype ?? '').toUpperCase().trim();
    if (tt !== want) continue;
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
  SHEET_MAIL,
  SHEET_DRAFTS,
};
