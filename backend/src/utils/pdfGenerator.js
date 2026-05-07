const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const ValidationResult = require('../models/ValidationResult');
const { findDestCustomFolder, buildPdfValidationView } = require('./gmailOutlookLabelMatch');

const MARGIN = 50;
const PAGE_WIDTH = 595;
const CONTENT_W = PAGE_WIDTH - MARGIN * 2;

const MISMATCH_RED = '#b91c1c';
const WARNING_AMBER = '#c2410c';

/**
 * Embed a Unicode-capable TTF so characters like →, •, €, £, and emoji render correctly.
 * PDFKit's built-in Helvetica is WinAnsi-only and substitutes unknown codepoints with
 * broken glyphs (e.g. → rendered as "!'"). We probe well-known font paths on Windows/macOS/
 * Linux and fall back to Helvetica only when nothing is available, so reports still render.
 *
 * Resolved font names used throughout the document: F_REGULAR, F_BOLD, F_ITALIC.
 */
const FONT_CANDIDATES = {
  regular: [
    'C:/Windows/Fonts/arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
  ],
  bold: [
    'C:/Windows/Fonts/arialbd.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  ],
  italic: [
    'C:/Windows/Fonts/ariali.ttf',
    '/System/Library/Fonts/Supplemental/Arial Italic.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Oblique.ttf',
  ],
};

function firstExistingPath(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

let F_REGULAR = 'Helvetica';
let F_BOLD = 'Helvetica-Bold';
let F_ITALIC = 'Helvetica-Oblique';

function registerUnicodeFonts(doc) {
  const reg = firstExistingPath(FONT_CANDIDATES.regular);
  const bold = firstExistingPath(FONT_CANDIDATES.bold);
  const ital = firstExistingPath(FONT_CANDIDATES.italic);
  if (reg) {
    try {
      doc.registerFont('Unicode', reg);
      F_REGULAR = 'Unicode';
    } catch { F_REGULAR = 'Helvetica'; }
  }
  if (bold) {
    try {
      doc.registerFont('UnicodeBold', bold);
      F_BOLD = 'UnicodeBold';
    } catch { F_BOLD = 'Helvetica-Bold'; }
  }
  if (ital) {
    try {
      doc.registerFont('UnicodeItalic', ital);
      F_ITALIC = 'UnicodeItalic';
    } catch { F_ITALIC = 'Helvetica-Oblique'; }
  }
}

/**
 * Rebuild per-message rows when `messageResults` was not stored on the execution (older runs / truncation).
 * Uses deepMail mismatches from ValidationResult.computeOverallStatus (structuredDiffs + messageSubject).
 */
function fallbackDeepMailRowsFromMismatches(validation) {
  return (validation.mismatches || [])
    .filter((m) => m.category === 'deepMail')
    .map((m) => ({
      subject: m.messageSubject || '(no subject)',
      internetMessageId: typeof m.field === 'string' ? m.field : '',
      sourceMessageId: typeof m.field === 'string' ? m.field : '',
      destMessageId: null,
      pass: false,
      diffs: [],
      note: String(m.actual || m.summaryLine || '').trim() || undefined,
      pdfStructuredDiffs: Array.isArray(m.structuredDiffs) ? m.structuredDiffs : null,
    }));
}

function normalizeDeepMailResultsForPdf(validation) {
  const deep = validation.deepMailValidation || {};
  let results = Array.isArray(deep.messageResults) ? [...deep.messageResults] : [];

  if (results.length === 0) {
    results = fallbackDeepMailRowsFromMismatches(validation);
  }

  return { deep, results };
}

function structuredRowsForDeepPdfRow(r) {
  if (Array.isArray(r.pdfStructuredDiffs) && r.pdfStructuredDiffs.length > 0) {
    return r.pdfStructuredDiffs.map((x) => ({
      fieldKey: x.fieldKey,
      fieldLabel: x.fieldLabel,
      sourceExpected: x.sourceExpected,
      destinationActual: x.destinationActual,
      severity: x.severity || 'error',
    }));
  }
  return ValidationResult.buildStructuredDiffRowsFromDiffs(r.diffs || [], r.note);
}

function contentLeft(doc) {
  return doc.page.margins.left;
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function ensureSpace(doc, y, needed) {
  if (y + needed > pageBottom(doc)) {
    doc.addPage();
    return doc.page.margins.top;
  }
  return y;
}

function drawSectionHeader(doc, title) {
  const left = contentLeft(doc);
  doc.fontSize(13).font(F_BOLD).fillColor('#1e293b').text(title, left, doc.y, {
    width: CONTENT_W,
  });
  const lineY = doc.y + 2;
  doc.moveTo(left, lineY).lineTo(left + CONTENT_W, lineY).strokeColor('#cbd5e1').lineWidth(0.75).stroke();
  doc.moveDown(0.4);
}

/** Tight key-value block (less padding below — use after tables to avoid large gaps). */
function drawMetadataTableCompact(doc, pairs) {
  const left = contentLeft(doc);
  const labelW = 200;
  const valueW = CONTENT_W - labelW;
  let y = doc.y;
  doc.fontSize(10);
  for (const [label, value] of pairs) {
    const v = String(value ?? '—');
    const valueH = doc.heightOfString(v, { width: valueW });
    const rowH = Math.max(doc.heightOfString(`${label}:`, { width: labelW }), valueH) + 3;
    y = ensureSpace(doc, y, rowH);
    doc.font(F_BOLD).fillColor('#475569').text(`${label}:`, left, y, { width: labelW });
    doc.font(F_REGULAR).fillColor('#0f172a').text(v, left + labelW, y, { width: valueW, lineGap: 1 });
    y += rowH;
  }
  doc.x = left;
  doc.y = y + 2;
}

/**
 * Key-value block with aligned values (metadata).
 */
function drawMetadataTable(doc, pairs) {
  const left = contentLeft(doc);
  const labelW = 220;
  const valueW = CONTENT_W - labelW;
  let y = doc.y;
  doc.fontSize(10);
  for (const [label, value] of pairs) {
    const v = String(value ?? 'N/A');
    const valueH = doc.heightOfString(v, { width: valueW });
    const rowH = Math.max(doc.heightOfString(`${label}:`, { width: labelW }), valueH) + 4;
    y = ensureSpace(doc, y, rowH);
    doc.font(F_BOLD).fillColor('#475569').text(`${label}:`, left, y, { width: labelW });
    doc.font(F_REGULAR).fillColor('#0f172a').text(v, left + labelW, y, { width: valueW, lineGap: 2 });
    y += rowH;
  }
  doc.x = left;
  doc.y = y + 6;
}

/**
 * Table with shaded header, grid alignment, variable row height for wrapped text.
 */
function drawDataTable(doc, headers, rows, colWidths) {
  const left = contentLeft(doc);
  const tableW = colWidths.reduce((a, b) => a + b, 0);
  let y = doc.y;

  const drawHeader = () => {
    const headerH = 22;
    y = ensureSpace(doc, y, headerH);
    doc.save();
    doc.fillColor('#f1f5f9');
    doc.rect(left, y, tableW, headerH).fill();
    doc.restore();
    let x = left;
    doc.font(F_BOLD).fontSize(9).fillColor('#334155');
    headers.forEach((h, i) => {
      doc.text(h, x + 5, y + 6, { width: colWidths[i] - 10, lineGap: 1 });
      x += colWidths[i];
    });
    doc.strokeColor('#94a3b8').lineWidth(0.5);
    doc.moveTo(left, y + headerH).lineTo(left + tableW, y + headerH).stroke();
    y += headerH;
  };

  drawHeader();

  doc.font(F_REGULAR).fontSize(9);
  for (const row of rows) {
    const cells = row.map((c) => String(c ?? ''));
    let maxH = 12;
    for (let i = 0; i < cells.length; i++) {
      const h = doc.heightOfString(cells[i], { width: colWidths[i] - 10 });
      maxH = Math.max(maxH, h);
    }
    const padY = 6;
    const rowH = maxH + padY * 2;
    y = ensureSpace(doc, y, rowH);

    let x = left;
    const statusIdx = cells.length - 1;
    for (let i = 0; i < cells.length; i++) {
      const text = cells[i];
      let color = '#0f172a';
      if (i === statusIdx) {
        if (text === 'Mismatch' || text === 'No' || text === 'NOT FOUND') color = '#b91c1c';
        else if (text === 'Match' || text === 'Yes') color = '#15803d';
        else if (text === 'Not measured') color = '#64748b';
      }
      doc.fillColor(color);
      doc.text(text, x + 5, y + padY, { width: colWidths[i] - 10, lineGap: 2 });
      x += colWidths[i];
    }
    doc.strokeColor('#e2e8f0').lineWidth(0.4);
    doc.moveTo(left, y + rowH).lineTo(left + tableW, y + rowH).stroke();
    y += rowH;
  }

  doc.x = left;
  doc.y = y + 3;
}

/**
 * Limit very long body cells so PDF rows stay bounded.
 */
function truncatePdfCell(text, maxChars) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 24))}\n… (truncated)`;
}

/**
 * Three-column table: Field | Source mailbox (Gmail) | Destination mailbox (Outlook).
 * Rows use raw Gmail vs Outlook values; From/To/Cc/Bcc “expected after mapping” is evaluated internally only.
 */
function drawFieldComparisonTable(doc, structuredRows) {
  const left = contentLeft(doc);
  const fieldW = 92;
  const srcW = (CONTENT_W - fieldW) / 2;
  const dstW = srcW;
  let y = doc.y;

  const headerH = 22;
  y = ensureSpace(doc, y, headerH);
  doc.save();
  doc.fillColor('#f1f5f9');
  doc.rect(left, y, CONTENT_W, headerH).fill();
  doc.restore();
  doc.font(F_BOLD).fontSize(9).fillColor('#334155');
  doc.text('Field', left + 5, y + 6, { width: fieldW - 10 });
  doc.text('Source (Gmail)', left + fieldW + 5, y + 6, { width: srcW - 10 });
  doc.text('Destination (Outlook)', left + fieldW + srcW + 5, y + 6, { width: dstW - 10 });
  doc.strokeColor('#94a3b8').lineWidth(0.5);
  doc.moveTo(left, y + headerH).lineTo(left + CONTENT_W, y + headerH).stroke();
  y += headerH;

  doc.font(F_REGULAR).fontSize(8);
  for (const row of structuredRows) {
    const fld = String(row.fieldLabel || row.fieldKey || '');
    const sev = row.severity || 'error';
    const valueColor =
      sev === 'error' ? MISMATCH_RED : sev === 'warning' ? WARNING_AMBER : '#0f172a';
    const bodyMax = fld === 'Body' ? 2200 : fld === 'Error' ? 2800 : 950;
    const srcT = truncatePdfCell(row.sourceExpected, bodyMax);
    const dstT = truncatePdfCell(row.destinationActual, bodyMax);

    let maxH = 12;
    maxH = Math.max(
      maxH,
      doc.heightOfString(fld, { width: fieldW - 10 }),
      doc.heightOfString(srcT, { width: srcW - 10 }),
      doc.heightOfString(dstT, { width: dstW - 10 })
    );
    const padY = 5;
    const rowH = maxH + padY * 2;
    y = ensureSpace(doc, y, rowH);

    doc.font(F_BOLD).fillColor('#334155').text(fld, left + 5, y + padY, {
      width: fieldW - 10,
      lineGap: 1,
    });
    doc.font(F_REGULAR).fillColor(valueColor).text(srcT, left + fieldW + 5, y + padY, {
      width: srcW - 10,
      lineGap: 1,
    });
    doc.fillColor(valueColor).text(dstT, left + fieldW + srcW + 5, y + padY, {
      width: dstW - 10,
      lineGap: 1,
    });
    doc.strokeColor('#e2e8f0').lineWidth(0.4);
    doc.moveTo(left, y + rowH).lineTo(left + CONTENT_W, y + rowH).stroke();
    y += rowH;
  }

  doc.x = left;
  doc.y = y + 4;
}

/**
 * Per-message Gmail vs Outlook comparison tables. Always emitted when validation exists so reports stay
 * consistent; uses messageResults when present, otherwise rebuilds rows from deepMail mismatches.
 */
function drawDeepMailPerMessageSection(doc, validation) {
  const { deep, results } = normalizeDeepMailResultsForPdf(validation);
  const mmDeep = (validation.mismatches || []).filter((m) => m.category === 'deepMail').length;

  // Section is always drawn for migration QA PDFs (requirement: visible at minimum with explanation).
  if (results.length === 0) {
    drawSectionHeader(doc, 'Per-message migration validation');
    doc.x = contentLeft(doc);
    const body =
      deep.summary ||
      (mmDeep > 0
        ? `Deep-mail findings were recorded (${mmDeep}) but detailed per-message rows were not stored on this execution. Re-download the PDF after updating the server, or re-run validation.`
        : 'No per-message rows were recorded. Deep validation may have been skipped (destination not Microsoft, DISABLE_DEEP_MAIL_VALIDATION), or no QA-tagged messages were found in scanned Gmail labels (INBOX/SENT).');
    doc.fontSize(10).font(F_REGULAR).fillColor('#64748b').text(body, { width: CONTENT_W, lineGap: 2 });
    doc.moveDown(0.35);
    return;
  }

  const failed = results.filter((r) => !r.pass);
  const failN = failed.length;
  const totalN = results.length;

  const title =
    failN > 0
      ? failN === totalN
        ? `Per-message migration validation (${failN} failed)`
        : `Per-message migration validation (${failN} failed of ${totalN})`
      : `Per-message migration validation (all ${totalN} passed)`;

  drawSectionHeader(doc, title);
  doc.x = contentLeft(doc);
  doc.fontSize(9).font(F_REGULAR).fillColor('#64748b').text(
    'Each row compares the same field on the Gmail source mailbox vs the Outlook destination mailbox. Red indicates a mismatch (amber for warnings). Recipient fields are compared after applying your permission mappings.',
    { width: CONTENT_W, lineGap: 2 }
  );
  doc.moveDown(0.35);

  if (failN === 0) {
    doc.fontSize(10).font(F_REGULAR).fillColor('#15803d').text(
      'All scanned and paired messages passed deep field comparison.',
      { width: CONTENT_W }
    );
    doc.moveDown(0.35);
    return;
  }

  for (const r of failed) {
    const subj = String(r.subject || '(no subject)').trim() || '(no subject)';
    const ref = truncateRef(r.internetMessageId || r.sourceMessageId || '—', 72);
    doc.x = contentLeft(doc);
    doc.fontSize(10).font(F_BOLD).fillColor('#0f172a').text(subj, { width: CONTENT_W });
    doc.fontSize(8).font(F_REGULAR).fillColor('#64748b').text(ref, { width: CONTENT_W });
    doc.moveDown(0.15);

    const rows = structuredRowsForDeepPdfRow(r);
    if (rows.length === 0) {
      doc.fontSize(9).font(F_REGULAR).fillColor(MISMATCH_RED).text(String(r.note || 'No diff details recorded.'), {
        width: CONTENT_W,
      });
    } else {
      drawFieldComparisonTable(doc, rows);
    }
    doc.moveDown(0.45);
  }
}

function statusLabel(match) {
  return match ? 'Match' : 'Mismatch';
}

/** Infer mismatch.kind for executions saved before enriched metadata existed. */
function inferMismatchKind(m) {
  if (m.kind) return m.kind;
  const cat = String(m.category || '');
  const a = String(m.actual || '');
  if (cat === 'comparison') return 'comparison';
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo|EAI_|full read failed|token failed/i.test(a)) return 'infrastructure';
  if (/attachments?:|attachmentHash/i.test(a)) return 'attachment';
  if (/field: from\b|field: to\b|field: cc\b|field: bcc\b/i.test(a)) return 'headers';
  if (/field: subject\b/i.test(a)) return 'subject';
  if (/field: folder\b/i.test(a)) return 'folder';
  if (cat === 'mail') return 'mailbox';
  if (cat === 'calendar') return 'calendar';
  if (cat === 'deepMail') return 'other';
  return 'other';
}

function truncateRef(s, max = 52) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const keep = Math.floor((max - 3) / 2);
  return `${t.slice(0, keep)}…${t.slice(-keep)}`;
}

/** Format a duration in milliseconds as "10m 30s" / "1h 5m 20s" for human readability. */
function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'N/A';
  if (n < 1000) return `${n} ms`;
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/** Resolve the current runtime timezone abbreviation (e.g. "IST", "UTC") for report timestamps. */
function currentTzAbbrev() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === 'timeZoneName');
    return tz?.value || '';
  } catch {
    return '';
  }
}

function formatTimestamp(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const tz = currentTzAbbrev();
  return tz ? `${d.toLocaleString()} ${tz}` : d.toLocaleString();
}

const GROUP_ORDER = [
  'infrastructure',
  'attachment',
  'headers',
  'subject',
  'folder',
  'mailbox',
  'calendar',
  'comparison',
  'other',
];

const GROUP_SECTION_TITLE = {
  infrastructure: 'Network / API failures (often transient — re-run validation when online)',
  attachment: 'Attachment differences (Tier A name + size vs destination)',
  headers: 'Header mismatches (From / To / Cc / Bcc vs permission mapping)',
  subject: 'Subject mismatches',
  folder: 'Folder / label placement (structure vs destination folder)',
  mailbox: 'Mailbox accessibility / structure',
  calendar: 'Calendar checks',
  comparison: 'Folder & label counts',
  other: 'Other findings',
};

function summarizeMismatchKinds(mismatches) {
  const counts = {};
  for (const m of mismatches || []) {
    const k = inferMismatchKind(m);
    counts[k] = (counts[k] || 0) + 1;
  }
  const parts = GROUP_ORDER.filter((k) => counts[k])
    .map((k) => `${counts[k]} ${k}`)
    .join(', ');
  return { counts, summaryText: parts || 'none' };
}

/**
 * Classify one failed deep-mail message into a human-friendly reason bucket so the executive
 * summary can collapse repeats ("11 messages: body text missing; attachments present") and
 * point the reader at the right next action.
 */
function classifyDeepMailReason(result) {
  const diffs = Array.isArray(result?.diffs) ? result.diffs : [];
  const structured = Array.isArray(result?.pdfStructuredDiffs) ? result.pdfStructuredDiffs : [];
  const errDiffs = diffs.filter((d) => d.ok === false && d.severity !== 'warning');
  const fields = new Set(errDiffs.map((d) => String(d.field || '')));
  const blob = [
    ...errDiffs.map((d) => `${d.field || ''} ${d.displayDestination || ''} ${d.actual || ''}`),
    ...structured.map((s) => `${s.fieldKey || ''} ${s.destinationActual || ''}`),
    String(result?.note || ''),
  ].join(' ');

  if (
    fields.has('body') &&
    /only the text body is missing|text body missing \(attachments migrated|text body missing; attachments present/i.test(blob)
  ) {
    return {
      key: 'body_text_missing_attachments_present',
      label: 'Text body missing (attachments migrated OK)',
      action: 'Re-migrate these messages or raise a support ticket.',
    };
  }
  if (
    fields.has('body') &&
    /body and attachments missing|destination body is empty|body is empty/i.test(blob)
  ) {
    return {
      key: 'body_empty_whole_message',
      label: 'Body and attachments missing on destination',
      action: 'Likely the whole message payload was dropped. Re-migrate or raise a support ticket.',
    };
  }
  if (fields.has('body')) {
    return {
      key: 'body_mismatch',
      label: 'Body content differs between source and destination',
      action: 'Review the Body row on the per-message section to see the diff.',
    };
  }
  if (fields.has('folder') || fields.has('starred') || fields.has('important')) {
    return {
      key: 'folder_or_flag_mismatch',
      label: 'Folder / flag / importance placement mismatch',
      action: 'Check label-to-folder mapping (STARRED → red flag, IMPORTANT → high) and Migrate Orphaned Labels setting.',
    };
  }
  if (fields.has('attachments') || [...fields].some((f) => String(f).startsWith('attachmentHash'))) {
    return {
      key: 'attachments_mismatch',
      label: 'Attachment manifest or byte-hash mismatch',
      action: 'Inspect attachment names/sizes; Tier B hash row shows which file differs.',
    };
  }
  if (['from', 'to', 'cc', 'bcc'].some((f) => fields.has(f))) {
    return {
      key: 'recipients_mapping_mismatch',
      label: 'Recipient (From/To/Cc/Bcc) does not match permission mapping',
      action: 'CloudFuze preserves original addresses; check whether the permission mapping reflects the migrated identities or adjust the mapping.',
    };
  }
  if (fields.has('subject')) {
    return {
      key: 'subject_mismatch',
      label: 'Subject line differs',
      action: 'Review subject encoding (MIME encoded-words, truncation) on the per-message section.',
    };
  }
  if (
    /ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo|EAI_|full read failed|token failed|network/i.test(blob)
  ) {
    return {
      key: 'network_or_api',
      label: 'Network / API errors during validation',
      action: 'Often transient — re-run validation when connectivity is stable.',
    };
  }
  return {
    key: 'other',
    label: 'Other deep-mail mismatch',
    action: 'Open the per-message section for details.',
  };
}

/**
 * Build a reason-grouped summary of failing deep-mail results.
 * @returns {Array<{ key, label, action, count, sampleSubjects }>}
 */
function buildDeepMailReasonGroups(results) {
  const groups = new Map();
  for (const r of results || []) {
    if (r.pass) continue;
    const reason = classifyDeepMailReason(r);
    if (!groups.has(reason.key)) {
      groups.set(reason.key, {
        key: reason.key,
        label: reason.label,
        action: reason.action,
        count: 0,
        sampleSubjects: [],
      });
    }
    const g = groups.get(reason.key);
    g.count += 1;
    if (g.sampleSubjects.length < 5) {
      const subj = String(r.subject || '(no subject)').trim() || '(no subject)';
      g.sampleSubjects.push(subj);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Narrative summary + bullet stats after Overall status.
 * When deep-mail failures exist, show them grouped by reason with sample subjects and
 * concrete next actions, so a reader gets the full verdict without paging through 50+
 * per-message tables.
 */
function drawReportAtAGlance(doc, validation, context) {
  const mm = validation.mismatches || [];
  const { counts } = summarizeMismatchKinds(mm);
  const deep = validation.deepMailValidation;
  const { results: deepResults } = normalizeDeepMailResultsForPdf(validation);
  const deepFailed = deepResults.filter((r) => !r.pass);
  const reasonGroups = buildDeepMailReasonGroups(deepResults);

  drawSectionHeader(doc, 'Report at a glance');
  doc.x = contentLeft(doc);
  doc.fontSize(10).font(F_REGULAR).fillColor('#334155');

  const overall = validation.overallStatus === 'PASS';
  if (overall) {
    doc.text('No blocking mismatches were recorded for this run.', { width: CONTENT_W, lineGap: 2 });
    doc.moveDown(0.35);
    return;
  }

  // One-line verdict sized by the actual number of deep-mail failures (the thing users care about).
  if (deep?.enabled && deepResults.length > 0) {
    const totalN = deepResults.length;
    const failN = deepFailed.length;
    const pct = totalN > 0 ? Math.round((failN / totalN) * 100) : 0;
    doc.text(
      `${failN} of ${totalN} deep-mail messages failed (${pct}%). ${mm.length} total finding(s) recorded.`,
      { width: CONTENT_W, lineGap: 2 }
    );
  } else {
    doc.text(`This run recorded ${mm.length} finding(s).`, { width: CONTENT_W, lineGap: 2 });
  }
  doc.moveDown(0.35);

  // Failures by reason — the most important section for a QA reader.
  if (reasonGroups.length > 0) {
    doc.font(F_BOLD).fontSize(11).fillColor('#334155').text('Failures by reason', { width: CONTENT_W });
    doc.moveDown(0.2);
    for (const g of reasonGroups) {
      doc.x = contentLeft(doc);
      doc.font(F_BOLD).fontSize(10).fillColor(MISMATCH_RED)
        .text(`${g.count} × ${g.label}`, { width: CONTENT_W, lineGap: 2 });
      doc.font(F_REGULAR).fontSize(9).fillColor('#475569')
        .text(`Action: ${g.action}`, { width: CONTENT_W, lineGap: 2 });
      if (g.sampleSubjects.length > 0) {
        const more = g.count > g.sampleSubjects.length ? ` (+${g.count - g.sampleSubjects.length} more)` : '';
        doc.font(F_REGULAR).fontSize(9).fillColor('#64748b')
          .text(`Examples: ${g.sampleSubjects.join(' · ')}${more}`, { width: CONTENT_W, lineGap: 2 });
      }
      doc.moveDown(0.25);
    }
  }

  if (deep?.enabled) {
    doc.moveDown(0.1);
    doc.font(F_BOLD).fontSize(10).fillColor('#475569').text('Deep mail validation', { continued: false });
    doc.moveDown(0.15);
    doc.font(F_REGULAR).fontSize(10).fillColor('#0f172a');
    if (deep.summary) {
      doc.text(deep.summary, { width: CONTENT_W, lineGap: 2 });
      doc.moveDown(0.25);
    }
    drawMetadataTableCompact(doc, [
      ['Messages scanned (source)', String(deep.scannedSourceMessages ?? '—')],
      ['Paired (source → destination)', String(deep.pairedCount ?? '—')],
      ['Deep mail failures', String(mm.filter((m) => m.category === 'deepMail').length)],
    ]);
  }

  doc.moveDown(0.35);

  const hintLines = [];
  if ((counts.infrastructure || 0) > 0) {
    hintLines.push(
      '• Network/API errors may clear after connectivity stabilizes — not migration logic defects by themselves.'
    );
  }
  if ((counts.attachment || 0) > 0) {
    hintLines.push(
      '• Attachment size differences often reflect MIME wrapping or transport; use Tier B hash validation for byte-level proof.'
    );
  }
  if (hintLines.length > 0) {
    doc.fontSize(9).font(F_REGULAR).fillColor('#64748b');
    doc.text(hintLines.join('\n'), { width: CONTENT_W, lineGap: 3 });
    doc.moveDown(0.35);
  }
}

/**
 * Grouped detail tables (excludes duplicate comparison rows when Comparison issues table exists).
 * Deep-mail rows are omitted when per-message failure tables are shown below (same content, richer there).
 */
function drawDetailedFindings(doc, validation) {
  const issues = validation.comparison?.issues || [];
  const { results: deepResults } = normalizeDeepMailResultsForPdf(validation);
  const showRichDeep = deepResults.some((r) => !r.pass);

  let rows = [...(validation.mismatches || [])];
  if (showRichDeep) {
    rows = rows.filter((m) => m.category !== 'deepMail');
  }
  if (issues.length > 0) {
    rows = rows.filter((m) => m.category !== 'comparison');
  }

  if (rows.length === 0) return;

  drawSectionHeader(doc, `Detailed findings (${rows.length})`);

  const byKind = {};
  for (const m of rows) {
    const k = inferMismatchKind(m);
    if (!byKind[k]) byKind[k] = [];
    byKind[k].push(m);
  }

  for (const kind of GROUP_ORDER) {
    const group = byKind[kind];
    if (!group?.length) continue;

    doc.x = contentLeft(doc);
    doc.fontSize(11).font(F_BOLD).fillColor('#334155').text(GROUP_SECTION_TITLE[kind] || kind);
    doc.moveDown(0.25);

    const tableRows = group.map((m) => {
      const ref = truncateRef(m.field || '—', 56);
      const detail = String(m.actual || m.summaryLine || '—').trim();
      const typeCol = m.kindLabel || GROUP_SECTION_TITLE[kind] || kind;
      return [typeCol, ref, detail];
    });

    const cw = [118, 128, CONTENT_W - 118 - 128];
    drawDataTable(doc, ['Issue type', 'Message / reference', 'What was wrong'], tableRows, cw);
    doc.moveDown(0.25);
  }
}

function generateValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  registerUnicodeFonts(doc);
  doc.pipe(stream);

  const result = execution.result;
  let validation = result?.validationSummary;
  if (!validation && result?.agentResults) {
    const outlook = result.agentResults.find((a) => a.name === 'OutlookValidationAgent');
    validation = outlook?.result || null;
  }
  if (validation) {
    validation = buildPdfValidationView(validation);
  }
  const context = execution.context;

  doc.fontSize(22).font(F_BOLD).fillColor('#0f172a').text('Migration QA Validation Report', MARGIN, 50, {
    width: CONTENT_W,
    align: 'center',
  });
  doc.moveDown(0.3);
  doc.fontSize(10).font(F_REGULAR).fillColor('#64748b').text(`Generated: ${formatTimestamp(new Date())}`, {
    width: CONTENT_W,
    align: 'center',
  });
  doc.x = MARGIN;
  doc.moveDown(1.2);

  drawSectionHeader(doc, 'Execution details');
  const mapN = Array.isArray(context?.userEmailMappings) ? context.userEmailMappings.length : 0;
  drawMetadataTable(doc, [
    ['Execution ID', execution.executionId],
    ['Source email', context?.sourceEmail || 'N/A'],
    ['Destination email', context?.destinationEmail || 'N/A'],
    ['Test type', context?.testType || 'E2E'],
    ['Migration type', context?.migrationType === 'DELTA' ? 'DELTA (delta)' : 'FULL (one-time)'],
    ['Calendar scope', context?.includeCalendar ? 'Included' : 'Skipped'],
    ['Contacts scope', context?.includeContacts ? 'Included' : 'Skipped'],
    ['Permission mappings (pairs)', mapN > 0 ? String(mapN) : 'None'],
    ['Run status', result?.status || 'N/A'],
    ['Duration', result?.duration != null ? formatDurationMs(result.duration) : 'N/A'],
    ['Started', formatTimestamp(execution.createdAt)],
  ]);

  drawSectionHeader(doc, 'Overall status');
  doc.x = contentLeft(doc);
  const statusColor = validation?.overallStatus === 'PASS' ? '#15803d' : '#b91c1c';
  doc.fontSize(16).font(F_BOLD).fillColor(statusColor).text(validation?.overallStatus || 'N/A');
  doc.moveDown(0.4);

  if (validation?.comparison) {
    const c = validation.comparison;
    doc.x = contentLeft(doc);
    doc.fontSize(10).font(F_REGULAR).fillColor('#334155');
    doc.text(
      `Default labels / folders: ${c.defaultLabelsMatch ? 'Match' : 'Mismatch'}  —  Custom labels / folders: ${c.customLabelsMatch ? 'Match' : 'Mismatch'}`,
      { width: CONTENT_W }
    );
    doc.moveDown(0.45);
  } else if (validation) {
    doc.moveDown(0.35);
  }

  if (validation) {
    drawReportAtAGlance(doc, validation, context);
  }

  if (!validation) {
    doc.x = contentLeft(doc);
    doc.fontSize(10).font(F_REGULAR).fillColor('#64748b').text('No validation data available.');
    doc.end();
    return;
  }

  const mail = validation.mailValidation;
  const cal = validation.calendarValidation;
  const includeCalendar = context?.includeCalendar !== false;
  const colDefault = [200, 72, 72, 95];

  if (validation.sourceData && validation.destinationData) {
    drawSectionHeader(doc, 'Default labels vs folders');
    const defaultRows = buildComparisonRows(
      validation.sourceData.defaultLabels || [],
      validation.destinationData.defaultFolders || [],
      { INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email' }
    );
    drawDataTable(doc, ['Label / folder', 'Source', 'Destination', 'Status'], defaultRows, colDefault);

    drawSectionHeader(doc, 'Custom labels vs folders');
    const customRows = [];
    for (const src of validation.sourceData.customLabels || []) {
      const dest = findDestCustomFolder(validation.destinationData.customFolders || [], src.name);
      const match = dest ? src.messageCount === dest.messageCount : false;
      customRows.push([
        src.name,
        String(src.messageCount),
        dest ? String(dest.messageCount) : '—',
        dest ? statusLabel(match) : 'NOT FOUND',
      ]);
    }
    if (customRows.length > 0) {
      drawDataTable(doc, ['Label / folder', 'Source', 'Destination', 'Status'], customRows, colDefault);
    } else {
      doc.x = contentLeft(doc);
      doc.fontSize(10).font(F_REGULAR).fillColor('#64748b').text('No custom labels on source.');
      doc.moveDown(0.35);
    }
  }

  /**
   * 3-column table (metric | source | destination) that matches the **same scope** as the
   * Default- and Custom-folder comparison tables above. If all per-folder rows match, this
   * summary matches too (row-level Match == table-level Match).
   *
   * Earlier version mixed aggregations (Gmail getProfile.messagesTotal vs
   * sum-of-all-Outlook-folders) which produced 69 vs 81 even when all per-folder rows
   * showed Match. That inconsistency is fixed below by using:
   *
   *   Mail count  = Σ(mapped-default labels/folders counts) + Σ(custom counts)
   *   Labels count = 5 mapped defaults + custom count on each side
   *
   * The mailbox-wide totals (Gmail messagesTotal, Outlook all-folders sum) are still useful
   * and are surfaced as a footnote so nothing is lost — just not the primary comparison
   * number.
   */
  if (mail) {
    const MAPPED_DEFAULTS = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM'];
    const MAPPED_OUTLOOK = new Set(['Inbox', 'Sent Items', 'Drafts', 'Deleted Items', 'Junk Email']);

    const srcDefaults = validation.sourceData?.defaultLabels || [];
    const srcCustoms  = validation.sourceData?.customLabels  || [];
    const dstDefaults = validation.destinationData?.defaultFolders || [];
    const dstCustoms  = validation.destinationData?.customFolders  || [];

    const isMappedSrcDefault = (l) =>
      MAPPED_DEFAULTS.includes(String(l.id ?? l.name ?? '').toUpperCase());
    const isMappedDstDefault = (f) => MAPPED_OUTLOOK.has(String(f.name ?? ''));

    const srcDefaultCount = srcDefaults.filter(isMappedSrcDefault)
      .reduce((s, l) => s + (l.messageCount || 0), 0);
    const srcCustomCount = srcCustoms.reduce((s, l) => s + (l.messageCount || 0), 0);
    const srcMail = srcDefaultCount + srcCustomCount;

    const dstDefaultCount = dstDefaults.filter(isMappedDstDefault)
      .reduce((s, f) => s + (f.messageCount || 0), 0);
    const dstCustomCount = dstCustoms.reduce((s, f) => s + (f.messageCount || 0), 0);
    const dstMail = dstDefaultCount + dstCustomCount;

    const srcLabelsFolders =
      srcDefaults.filter(isMappedSrcDefault).length + srcCustoms.length;
    const dstLabelsFolders =
      dstDefaults.filter(isMappedDstDefault).length + dstCustoms.length;

    const srcCalendars =
      validation.calendarValidation?.sourceCalendarCount
      ?? ((validation.calendarValidation?.secondaryCalendars?.length || 0) + 1);
    const dstCalendars =
      validation.calendarValidation?.destinationCalendarCount
      ?? ((validation.calendarValidation?.secondaryCalendars?.length || 0) + 1);
    const srcContacts = validation.contactsValidation?.sourceCount ?? 0;
    const dstContacts = validation.contactsValidation?.destinationCount ?? 0;

    const mailMatch = srcMail === dstMail;
    const labelMatch = srcLabelsFolders === dstLabelsFolders;
    const calendarMatch = Number(srcCalendars) === Number(dstCalendars);
    const contactsMatch = Number(srcContacts) === Number(dstContacts);
    // Contacts row is only a real "Match" when we actually measured both sides. A 0/0 row with
    // available=false is really "Not measured" — surfacing it as "Match" is misleading.
    const contactsMeasured = validation.contactsValidation?.available !== false;
    const contactsStatus = !contactsMeasured
      ? 'Not measured'
      : statusLabel(contactsMatch);

    doc.moveDown(0.2);
    drawSectionHeader(doc, 'Mail validation summary');
    const summaryRows = [
      ['Mail count', String(srcMail), String(dstMail), statusLabel(mailMatch)],
      ['Labels / folders count', String(srcLabelsFolders), String(dstLabelsFolders), statusLabel(labelMatch)],
    ];
    if (includeCalendar) {
      summaryRows.push([
        'Calendars count',
        String(srcCalendars),
        String(dstCalendars),
        statusLabel(calendarMatch),
      ]);
    }
    summaryRows.push([
      'Contacts count',
      String(srcContacts),
      String(dstContacts),
      contactsStatus,
    ]);
    drawDataTable(
      doc,
      ['Metric', 'Source', 'Destination', 'Status'],
      summaryRows,
      [180, 70, 70, 115]
    );

    const mailboxSrc = Number(mail.sourceCount ?? 0);
    const mailboxDst = Number(mail.destinationCount ?? 0);
    if (mailboxSrc || mailboxDst) {
      doc.x = contentLeft(doc);
      doc.fontSize(8).font(F_ITALIC).fillColor('#64748b').text(
        `Note: "Mail count" above is the sum across compared folders (Inbox/Sent Items/Drafts/Deleted Items/Junk Email + custom). ` +
        `Mailbox-wide totals (for reference): source=${mailboxSrc} (Gmail getProfile.messagesTotal — unique message count after label overlap), ` +
        `destination=${mailboxDst} (sum of every Outlook folder, including Archive/Conversation History/Scheduled). ` +
        `A difference between these mailbox-wide numbers and the per-folder sum is expected: Gmail messages with multiple labels count once in messagesTotal but once per folder after migration; Outlook carries extra system folders (e.g. Archive) that Gmail does not.`,
        { width: CONTENT_W, lineGap: 1 }
      );
      doc.moveDown(0.15);
    }

    if (validation.contactsValidation && validation.contactsValidation.available === false) {
      doc.x = contentLeft(doc);
      doc.fontSize(8).font(F_ITALIC).fillColor('#64748b').text(
        'Contacts count shown as 0 because the source OAuth token lacks the contacts.readonly scope, or the Graph /me/contacts endpoint is inaccessible. Grant the scope to include this row.',
        { width: CONTENT_W, lineGap: 1 }
      );
      doc.moveDown(0.2);
    }

    if (includeCalendar && cal) {
      doc.moveDown(0.15);
      drawSectionHeader(doc, 'Calendar validation (details)');
      drawMetadataTableCompact(doc, [
        ['Total events (source)', String(cal.sourceEventCount ?? 0)],
        ['Total events (destination)', String(cal.destinationEventCount ?? 0)],
        ['Recurring (sampled)', String(cal.recurringEvents?.length || 0)],
        ['Secondary calendars', String(cal.secondaryCalendars?.length || 0)],
      ]);
    }
    doc.moveDown(0.2);
  }

  const issues = validation.comparison?.issues || [];
  if (issues.length > 0) {
    drawSectionHeader(doc, `Comparison issues (${issues.length})`);
    const issueRows = issues.map((issue) => [
      issue.label || issue.type || '—',
      String(issue.sourceCount ?? '—'),
      String(issue.destCount ?? '—'),
      'Mismatch',
    ]);
    drawDataTable(doc, ['Mapping', 'Source count', 'Dest count', 'Status'], issueRows, colDefault);
  }

  drawDeepMailPerMessageSection(doc, validation);

  if (validation.mismatches?.length > 0) {
    drawDetailedFindings(doc, validation);
  }

  doc.end();
}

function buildComparisonRows(sourceLabels, destFolders, mapping) {
  const rows = [];
  for (const [gmailId, outlookName] of Object.entries(mapping)) {
    const src = sourceLabels.find((l) => l.id === gmailId || l.name === gmailId);
    const dest = destFolders.find((f) => f.name === outlookName);
    const srcCount = src?.messageCount ?? 0;
    const destCount = dest?.messageCount ?? 0;
    const match = srcCount === destCount;
    rows.push([`${gmailId} → ${outlookName}`, String(srcCount), String(destCount), statusLabel(match)]);
  }
  return rows;
}

module.exports = { generateValidationPdf };
