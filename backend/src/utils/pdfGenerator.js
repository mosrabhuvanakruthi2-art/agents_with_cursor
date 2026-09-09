'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const ValidationResult = require('../models/ValidationResult');
const { findDestCustomFolder, buildPdfValidationView } = require('./gmailOutlookLabelMatch');
const { computeFunctionalityChecklist } = require('../validation/shared/functionalityChecklist');

const PROVIDER_LABELS = {
  google:      'Gmail',
  microsoft:   'Outlook',
  outlook:     'Outlook',
  gmail:       'Gmail',
  box:         'Box',
  sharepoint:  'SharePoint',
  onedrive:    'OneDrive',
  googledrive: 'Google Drive',
  dropbox:     'Dropbox',
};
function providerLabel(p) {
  return PROVIDER_LABELS[String(p || '').toLowerCase()] || String(p || '—');
}

const MARGIN     = 45;
const PAGE_WIDTH = 595;
const CONTENT_W  = PAGE_WIDTH - MARGIN * 2;

const C = {
  pass: '#16a34a',   passBg: '#f0fdf4',   passBorder: '#86efac',
  fail: '#dc2626',   failBg: '#fef2f2',   failBorder: '#fca5a5',
  warn: '#d97706',   warnBg: '#fffbeb',   warnBorder: '#fde68a',
  info: '#2563eb',   infoBg: '#eff6ff',   infoBorder: '#bfdbfe',
  dark:    '#1e293b', darkAlt: '#334155',  surface: '#ffffff',
  border:  '#e2e8f0', bg:      '#f8fafc',
  text:    '#0f172a', subtle:  '#64748b',  muted: '#94a3b8',
};

// ── Fonts ─────────────────────────────────────────────────────────────────────
const FONT_CANDIDATES = {
  regular: ['C:/Windows/Fonts/arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
  bold:    ['C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  italic:  ['C:/Windows/Fonts/ariali.ttf', '/System/Library/Fonts/Supplemental/Arial Italic.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf'],
  // Monospace — needed so the ├──└── folder-tree connectors line up. Box-drawing glyphs supported.
  mono:    ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/cour.ttf', '/System/Library/Fonts/Menlo.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'],
};

function firstExistingPath(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

let F_REGULAR = 'Helvetica';
let F_BOLD    = 'Helvetica-Bold';
let F_ITALIC  = 'Helvetica-Oblique';
let F_MONO    = 'Courier';

function registerUnicodeFonts(doc) {
  const reg  = firstExistingPath(FONT_CANDIDATES.regular);
  const bold = firstExistingPath(FONT_CANDIDATES.bold);
  const ital = firstExistingPath(FONT_CANDIDATES.italic);
  const mono = firstExistingPath(FONT_CANDIDATES.mono);
  if (reg)  { try { doc.registerFont('Unicode',       reg);  F_REGULAR = 'Unicode';       } catch { F_REGULAR = 'Helvetica';         } }
  if (bold) { try { doc.registerFont('UnicodeBold',   bold); F_BOLD    = 'UnicodeBold';   } catch { F_BOLD    = 'Helvetica-Bold';    } }
  if (ital) { try { doc.registerFont('UnicodeItalic', ital); F_ITALIC  = 'UnicodeItalic'; } catch { F_ITALIC  = 'Helvetica-Oblique'; } }
  if (mono) { try { doc.registerFont('Mono',          mono); F_MONO    = 'Mono';          } catch { F_MONO    = 'Courier';           } }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 'N/A';
  if (n < 1000) return `${n} ms`;
  const s = Math.round(n / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function currentTzAbbrev() {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

function formatTimestamp(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const tz = currentTzAbbrev();
  return tz ? `${d.toLocaleString()} ${tz}` : d.toLocaleString();
}

function truncateRef(s, max = 52) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const keep = Math.floor((max - 3) / 2);
  return `${t.slice(0, keep)}…${t.slice(-keep)}`;
}

function truncatePdfCell(text, maxChars) {
  const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 24))}\n… (truncated)`;
}

// ── Data processing ───────────────────────────────────────────────────────────
function fallbackDeepMailRowsFromMismatches(validation) {
  return (validation.mismatches || [])
    .filter((m) => m.category === 'deepMail')
    .map((m) => ({
      subject: m.messageSubject || '(no subject)',
      internetMessageId: typeof m.field === 'string' ? m.field : '',
      sourceMessageId:   typeof m.field === 'string' ? m.field : '',
      destMessageId: null, pass: false, diffs: [],
      note: String(m.actual || m.summaryLine || '').trim() || undefined,
      pdfStructuredDiffs: Array.isArray(m.structuredDiffs) ? m.structuredDiffs : null,
    }));
}

function normalizeDeepMailResultsForPdf(validation) {
  const deep = validation.deepMailValidation || {};
  let results = Array.isArray(deep.messageResults) ? [...deep.messageResults] : [];
  if (results.length === 0) results = fallbackDeepMailRowsFromMismatches(validation);
  return { deep, results };
}

function getExValidation(execution) {
  const result = execution?.result;
  let validation = result?.validationSummary;
  if (!validation && result?.agentResults) {
    const agent = result.agentResults.find((a) => a.name === 'OutlookValidationAgent');
    validation = agent?.result || null;
  }
  if (validation) validation = buildPdfValidationView(validation);
  return validation || null;
}

function getBulkOverallStatus(executions) {
  for (const ex of (executions || [])) {
    const v = getExValidation(ex);
    if (!v || v.overallStatus === 'FAIL') return 'FAIL';
  }
  return 'PASS';
}

function structuredRowsForDeepPdfRow(r) {
  if (Array.isArray(r.pdfStructuredDiffs) && r.pdfStructuredDiffs.length > 0) {
    return r.pdfStructuredDiffs.map((x) => ({
      fieldKey: x.fieldKey, fieldLabel: x.fieldLabel,
      sourceExpected: x.sourceExpected, destinationActual: x.destinationActual,
      severity: x.severity || 'error',
    }));
  }
  return ValidationResult.buildStructuredDiffRowsFromDiffs(r.diffs || [], r.note);
}

function inferMismatchKind(m) {
  if (m.kind) return m.kind;
  const cat = String(m.category || '');
  const a   = String(m.actual   || '');
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

function classifyDeepMailReason(result) {
  const diffs      = Array.isArray(result?.diffs) ? result.diffs : [];
  const structured = Array.isArray(result?.pdfStructuredDiffs) ? result.pdfStructuredDiffs : [];
  const errDiffs   = diffs.filter((d) => d.ok === false && d.severity !== 'warning');
  const fields     = new Set(errDiffs.map((d) => String(d.field || '')));
  const blob       = [
    ...errDiffs.map((d) => `${d.field||''} ${d.displayDestination||''} ${d.actual||''}`),
    ...structured.map((s) => `${s.fieldKey||''} ${s.destinationActual||''}`),
    String(result?.note || ''),
  ].join(' ');

  if (fields.has('body') && /only the text body is missing|text body missing/i.test(blob))
    return { key: 'body_text_missing', label: 'Text body missing (attachments migrated OK)', action: 'Re-migrate these messages or raise a support ticket.', severity: 'critical' };
  if (fields.has('body') && /body and attachments missing|destination body is empty|body is empty/i.test(blob))
    return { key: 'body_empty', label: 'Body and attachments missing on destination', action: 'Likely the whole message payload was dropped. Re-migrate or raise a support ticket.', severity: 'critical' };
  if (fields.has('body'))
    return { key: 'body_mismatch', label: 'Body content differs between source and destination', action: 'Review the Body row on the per-message section.', severity: 'critical' };
  if (fields.has('folder') || fields.has('starred') || fields.has('important'))
    return { key: 'folder_flag', label: 'Folder / flag / importance placement mismatch', action: 'Check label-to-folder mapping and Migrate Orphaned Labels setting.', severity: 'warning' };
  if (fields.has('attachments') || [...fields].some((f) => String(f).startsWith('attachmentHash')))
    return { key: 'attachments', label: 'Attachment manifest or byte-hash mismatch', action: 'Inspect attachment names/sizes; Tier B hash row shows which file differs.', severity: 'critical' };
  if (['from','to','cc','bcc'].some((f) => fields.has(f)))
    return { key: 'recipients', label: 'Recipient (From/To/Cc/Bcc) does not match permission mapping', action: 'Check whether the permission mapping reflects the migrated identities.', severity: 'warning' };
  if (fields.has('subject'))
    return { key: 'subject', label: 'Subject line differs', action: 'Review subject encoding on the per-message section.', severity: 'minor' };
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|getaddrinfo|EAI_|full read failed|token failed|network/i.test(blob))
    return { key: 'network', label: 'Network / API errors during validation', action: 'Often transient — re-run validation when connectivity is stable.', severity: 'minor' };
  return { key: 'other', label: 'Other deep-mail mismatch', action: 'Open the per-message section for details.', severity: 'warning' };
}

function buildDeepMailReasonGroups(results) {
  const groups = new Map();
  for (const r of results || []) {
    if (r.pass) continue;
    const reason = classifyDeepMailReason(r);
    if (!groups.has(reason.key)) groups.set(reason.key, { ...reason, count: 0, sampleSubjects: [] });
    const g = groups.get(reason.key);
    g.count++;
    if (g.sampleSubjects.length < 5)
      g.sampleSubjects.push(String(r.subject || '(no subject)').trim() || '(no subject)');
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function buildComparisonRows(sourceLabels, destFolders, mapping) {
  const rows = [];
  for (const [gmailId, outlookName] of Object.entries(mapping)) {
    const src      = sourceLabels.find((l) => l.id === gmailId || l.name === gmailId);
    const dest     = destFolders.find((f) => f.name === outlookName || f.name === gmailId);
    const srcCount  = src?.messageCount  ?? 0;
    const destCount = dest?.messageCount ?? 0;
    const match  = srcCount === destCount;
    const status = (!match && gmailId === 'TRASH' && destCount > srcCount) ? 'Accumulated' : (match ? 'Match' : 'Mismatch');
    rows.push({ label: `${gmailId} → ${outlookName}`, srcCount, destCount, status, nested: false });
  }
  return rows;
}

// ── Layout primitives ─────────────────────────────────────────────────────────
function pageBottom(doc) { return doc.page.height - doc.page.margins.bottom; }

function ensureSpace(doc, needed) {
  if (doc.y + needed > pageBottom(doc)) doc.addPage();
}

/**
 * Draw one line of text that MUST fit a fixed column, shrinking the font until it does.
 *
 * `lineBreak: false` tells PDFKit not to wrap, and PDFKit then happily draws past the width it was
 * given — so a long value ran straight over whatever sat to its right. That is the overlapping text
 * in the header meta band ("googleshareddrive -> SharePoint" needed 110pt in an 74pt column) and in
 * the CloudFuze status pill ("Processed" needed 40pt in 34pt).
 *
 * Shrinking beats truncating here: these are short labels a reviewer needs whole, and one point of
 * size costs nothing. Only if the floor is reached does it fall back to an ellipsis, which is still
 * better than silently painting over the neighbouring column.
 *
 * Restores the caller's font size, so it can be dropped in anywhere without side effects.
 */
function drawFitted(doc, text, x, y, width, opts = {}) {
  const str = String(text == null ? '' : text);
  if (!str) return;
  const startSize = doc._fontSize;
  const minSize = opts.minSize || 5.5;
  let size = startSize;
  while (size > minSize && doc.fontSize(size).widthOfString(str) > width) {
    size -= 0.25;
  }
  const fits = doc.fontSize(size).widthOfString(str) <= width;
  doc.text(str, x, y, {
    width,
    align: opts.align,
    lineBreak: false,
    // At the floor and still too wide: clip rather than overlap the next column.
    ...(fits ? {} : { ellipsis: true, height: size * 1.35 }),
  });
  doc.fontSize(startSize);
}

function hRule(doc, y, color = C.border) {
  doc.save().strokeColor(color).lineWidth(0.75)
    .moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke().restore();
}

function drawSectionHeader(doc, title) {
  ensureSpace(doc, 48);
  doc.moveDown(0.7);
  doc.fontSize(11).font(F_BOLD).fillColor(C.dark).text(title, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.15);
  hRule(doc, doc.y, '#cbd5e1');
  doc.moveDown(0.5);
}

function statusTagColors(status) {
  if (status === 'Match')     return { bg: C.passBg,  fg: C.pass   };
  if (status === 'Mismatch')  return { bg: C.failBg,  fg: C.fail   };
  if (status === 'NOT FOUND') return { bg: C.failBg,  fg: C.fail   };
  if (status === 'Accumulated') return { bg: '#f1f5f9', fg: C.subtle };
  return { bg: '#f1f5f9', fg: C.subtle };
}

function drawStatusBadge(doc, x, y, status) {
  let bg, fg;
  if (status === 'PASS')  { bg = C.passBg;  fg = C.pass;  }
  else if (status === 'WARN') { bg = C.warnBg;  fg = C.warn;  }
  else                    { bg = C.failBg;  fg = C.fail;  }
  doc.save().fillColor(bg).roundedRect(x, y, 74, 26, 5).fill().restore();
  doc.save().strokeColor(fg).lineWidth(1).roundedRect(x, y, 74, 26, 5).stroke().restore();
  doc.fontSize(11).font(F_BOLD).fillColor(fg).text(status, x, y + 7, { width: 74, align: 'center' });
}

// ── Page header ───────────────────────────────────────────────────────────────
function drawPageHeader(doc, execution, validation, context, result) {
  const status  = validation?.overallStatus || 'N/A';
  const genDate = formatTimestamp(new Date());
  const src     = context?.sourceEmail      || '—';
  const dest    = context?.destinationEmail || '—';

  // Dark header band (full bleed)
  doc.save().fillColor(C.dark).rect(0, 0, PAGE_WIDTH, 82).fill().restore();
  doc.fontSize(17).font(F_BOLD).fillColor('#ffffff')
    .text('Migration QA Validation Report', MARGIN, 18, { width: CONTENT_W - 90 });
  doc.fontSize(8.5).font(F_REGULAR).fillColor(C.muted)
    .text(`Generated: ${genDate}`, MARGIN, 45, { width: CONTENT_W - 90 });
  drawStatusBadge(doc, PAGE_WIDTH - MARGIN - 82, 18, status);

  // Light meta band
  doc.save().fillColor('#f1f5f9').rect(0, 82, PAGE_WIDTH, 44).fill().restore();
  // Full execution ID on its own row so it never gets truncated
  const fullExecId = String(execution.executionId || '—');
  doc.fontSize(7).font(F_REGULAR).fillColor(C.muted)
    .text(`Exec: ${fullExecId}`, MARGIN, 88, { width: CONTENT_W, lineBreak: false });

  const combination = (context?.sourceProvider || context?.destinationProvider)
    ? `${providerLabel(context.sourceProvider)} → ${providerLabel(context.destinationProvider)}`
    : `${src} → ${dest}`;
  const metaItems = [
    combination,
    `Type: ${context?.testType || 'E2E'}`,
    `Migration: ${context?.migrationType === 'DELTA' ? 'Delta' : 'One-time'}`,
    `Duration: ${result?.duration != null ? formatDurationMs(result.duration) : 'N/A'}`,
  ];
  // Reserve the right side of the meta band for the Initiated date (when the
  // migration run was started), separate from the "Generated" download date above.
  const initiated = execution?.createdAt ? formatTimestamp(execution.createdAt) : 'N/A';
  const initW   = 185;
  const leftW   = CONTENT_W - initW;
  const metaColW = leftW / metaItems.length;
  doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt);
  metaItems.forEach((item, i) => {
    drawFitted(doc, item, MARGIN + i * metaColW, 100, metaColW - 6);
  });
  doc.text(`Initiated: ${initiated}`, MARGIN + leftW, 100, { width: initW, align: 'right', lineBreak: false });

  doc.y = 140;
}

// Shared CF status → { label, bg, fg } badge styling (used by single + bulk status tables).
function cfStatusBadge(cfStatusRaw) {
  const up = String(cfStatusRaw || '—').toUpperCase();
  let label;
  if (up === 'PROCESSED_WITH_CONFLICTS' || up === 'PROCESS_WITH_CONFLICTS') label = 'Proc. w/ Conflicts';
  else if (/^PROCESS(ED)?$/.test(up)) label = 'Processed';
  else if (up === 'COMPLETED')   label = 'Completed';
  else if (up === 'IN_PROGRESS') label = 'In Progress';
  else if (up === 'INITIATED')   label = 'Initiated';
  else if (up === 'FAILED')      label = 'Failed';
  else if (up === 'CANCELLED')   label = 'Cancelled';
  else label = String(cfStatusRaw || '—').replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  let bg = '#f1f5f9', fg = C.subtle;
  if (/^PROCESS(ED)?$/.test(up) || up === 'COMPLETED') { bg = C.passBg; fg = C.pass; }
  else if (up === 'PROCESSED_WITH_CONFLICTS' || up === 'PROCESS_WITH_CONFLICTS') { bg = C.warnBg; fg = C.warn; }
  else if (/FAIL|ERROR/.test(up)) { bg = C.failBg; fg = C.fail; }
  else if (/PROGRESS|INPROG|QUEUE|INIT|RUN/.test(up)) { bg = '#dbeafe'; fg = '#1d4ed8'; }
  return { label, bg, fg };
}

// ── Combined CloudFuze Migration Status — one row per pair (bulk report) ──────
// Job ID is shared across a bulk run, so it's shown once in the strip; each row carries the
// pair's own Workspace ID / counts / CF status.
function drawBulkMigrationStatus(doc, executions) {
  const rows = (executions || []).map((ex) => ({
    migJob: ex.context?.migrationJobDetails
      || ex.result?.migrationResult?.migrationJobDetails
      || ex.result?.validationSummary?.migrationJobDetails
      || null,
    src: ex.context?.sourceEmail || '—',
    dst: ex.context?.destinationEmail || '—',
  }));
  if (rows.length === 0) return;

  drawSectionHeader(doc, 'CloudFuze Migration Status');

  const migJob0 = rows.find((r) => r.migJob)?.migJob || null;
  const serverUrl = String(migJob0?.serverUrl || '—');
  if (serverUrl && serverUrl !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Server: ${serverUrl}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }
  const jobIdReal = String(migJob0?.jobId || '—');
  const jobNameStr = String(migJob0?.jobName || '—');
  if (jobIdReal && jobIdReal !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job ID: ${jobIdReal}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }
  if (jobNameStr && jobNameStr !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job Name: ${jobNameStr}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }

  const COLS = [
    { label: 'Workspace ID', w: 110 },
    { label: 'From Email',   w: 110 },
    { label: 'To Email',     w: 110 },
    { label: 'Total',        w:  45 },
    { label: 'Processed',    w:  52 },
    { label: 'CF Status',    w:  CONTENT_W - 110 - 110 - 110 - 45 - 52 },
  ];
  const TABLE_W = COLS.reduce((s, c) => s + c.w, 0);
  const HDR_H = 22, ROW_H = 26;
  ensureSpace(doc, HDR_H + ROW_H * rows.length + 20);

  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, TABLE_W, HDR_H).fill().restore();
  let hx = MARGIN;
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  COLS.forEach((c) => { drawFitted(doc, c.label, hx + 5, y + 6, c.w - 10); hx += c.w; });
  doc.save().strokeColor('#94a3b8').lineWidth(0.5)
    .moveTo(MARGIN, y + HDR_H).lineTo(MARGIN + TABLE_W, y + HDR_H).stroke().restore();
  y += HDR_H;

  rows.forEach((row, idx) => {
    const mj = row.migJob;
    const workspaceId    = String(mj?.workspaceId || '—');
    const totalCount     = mj?.totalCount     != null ? String(mj.totalCount)     : '—';
    const processedCount = mj?.processedCount != null ? String(mj.processedCount) : '—';
    const badge = cfStatusBadge(mj?.cfStatus || '—');

    doc.save().fillColor(idx % 2 ? '#fafafa' : '#ffffff').rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();

    const cells = [
      { text: workspaceId,    w: COLS[0].w, badge: false },
      { text: row.src,        w: COLS[1].w, badge: false },
      { text: row.dst,        w: COLS[2].w, badge: false },
      { text: totalCount,     w: COLS[3].w, badge: false },
      { text: processedCount, w: COLS[4].w, badge: false },
      { text: null,           w: COLS[5].w, badge: true  },
    ];
    let rx = MARGIN;
    cells.forEach((cell) => {
      if (!cell.badge) {
        doc.fontSize(7.5).font(F_REGULAR).fillColor(C.text)
;
        drawFitted(doc, cell.text, rx + 5, y + 8, cell.w - 10);
      } else {
        const tagW = cell.w - 10;
        doc.save().fillColor(badge.bg).roundedRect(rx + 5, y + 6, tagW, 15, 3).fill().restore();
        doc.fontSize(7).font(F_BOLD).fillColor(badge.fg);
        drawFitted(doc, badge.label, rx + 5, y + 10, tagW, { align: 'center' });
      }
      rx += cell.w;
    });
    y += ROW_H;
  });
  doc.save().strokeColor('#e2e8f0').lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(MARGIN + TABLE_W, y).stroke().restore();
  doc.y = y + 8;
}

// ── Bulk cover: Pair Overview Grid ───────────────────────────────────────────
function drawPairOverviewGrid(doc, executions) {
  const COLS = [
    { label: 'Source → Destination', w: 165 },
    { label: 'Overall',              w:  60 },
    { label: 'Emails Chk',           w:  60 },
    { label: 'Matched',              w:  60 },
    { label: 'Mismatches',           w:  65 },
    { label: 'Duration',             w:  CONTENT_W - 165 - 60 - 60 - 60 - 65 },
  ];
  const TABLE_W = COLS.reduce((s, c) => s + c.w, 0);
  const HDR_H = 22, ROW_H = 30;

  ensureSpace(doc, HDR_H + ROW_H * executions.length + 10);
  let y = doc.y;

  doc.save().fillColor(C.dark).rect(MARGIN, y, TABLE_W, HDR_H).fill().restore();
  let hx = MARGIN;
  doc.fontSize(8).font(F_BOLD).fillColor('#92B5CC');
  COLS.forEach((c) => {
    drawFitted(doc, c.label, hx + 5, y + 7, c.w - 10);
    hx += c.w;
  });
  y += HDR_H;

  executions.forEach((ex) => {
    const v       = getExValidation(ex);
    const status  = v?.overallStatus || '—';
    const isFail  = status === 'FAIL';
    const deep    = v?.deepMailValidation || {};
    const { results: dr } = v ? normalizeDeepMailResultsForPdf(v) : { results: [] };
    const deepFailed = dr.filter((r) => !r.pass).length;
    const scanned = deep.scannedSourceMessages ?? '—';
    const paired  = deep.pairedCount ?? '—';
    const dur     = ex.result?.duration != null ? formatDurationMs(ex.result.duration) : '—';
    const src     = ex.context?.sourceEmail || '—';
    const dst     = ex.context?.destinationEmail || '—';

    doc.save().fillColor(isFail ? '#FFF8F8' : '#F7FDF9').rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();
    doc.save().fillColor(isFail ? C.fail : C.pass).rect(MARGIN, y, 3, ROW_H).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.5)
      .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + TABLE_W, y + ROW_H).stroke().restore();

    let rx = MARGIN;
    doc.fontSize(8).font(F_BOLD).fillColor(C.dark)
      .text(src, rx + 5, y + 5, { width: COLS[0].w - 10, lineBreak: false });
    doc.fontSize(7).font(F_REGULAR).fillColor(C.muted)
      .text('>', rx + 5, y + 17, { width: 10, lineBreak: false });
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(dst, rx + 14, y + 17, { width: COLS[0].w - 20, lineBreak: false });
    rx += COLS[0].w;

    const bW = COLS[1].w - 10;
    doc.save().fillColor(isFail ? C.failBg : C.passBg).roundedRect(rx + 3, y + 7, bW, 15, 3).fill().restore();
    doc.save().strokeColor(isFail ? C.fail : C.pass).lineWidth(0.5).roundedRect(rx + 3, y + 7, bW, 15, 3).stroke().restore();
    doc.fontSize(8).font(F_BOLD).fillColor(isFail ? C.fail : C.pass)
      .text(status, rx + 3, y + 11, { width: bW, align: 'center', lineBreak: false });
    rx += COLS[1].w;

    [[scanned, false], [paired, false], [deepFailed, true], [dur, false]].forEach(([val, isMis], ci) => {
      const col = COLS[2 + ci];
      const fc  = (isMis && Number(val) > 0) ? C.fail : C.text;
      doc.fontSize(9).font(F_BOLD).fillColor(fc)
        .text(String(val ?? '—'), rx + 5, y + 10, { width: col.w - 10, lineBreak: false });
      rx += col.w;
    });
    y += ROW_H;
  });

  doc.save().strokeColor(C.border).lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(MARGIN + TABLE_W, y).stroke().restore();
  doc.y = y + 8;
}

// ── Bulk cover: Failure Index ─────────────────────────────────────────────────
function drawFailureIndex(doc, executions) {
  const pairFailures = [];
  for (const ex of (executions || [])) {
    const v = getExValidation(ex);
    if (!v) continue;
    const { results } = normalizeDeepMailResultsForPdf(v);
    const failed = results.filter((r) => !r.pass);
    if (failed.length === 0) continue;
    pairFailures.push({ src: ex.context?.sourceEmail || '—', dst: ex.context?.destinationEmail || '—', failures: failed });
  }
  if (pairFailures.length === 0) return;

  drawSectionHeader(doc, 'Failure Index');

  const FI_COLS = [
    { label: 'Folder',        w:  90 },
    { label: 'Email Subject', w: 155 },
    { label: 'Field',         w:  55 },
    { label: 'Issue Detail',  w:  CONTENT_W - 90 - 155 - 55 },
  ];
  const FI_W   = FI_COLS.reduce((s, c) => s + c.w, 0);
  const HDR_H  = 18, ROW_H = 28, PH_H = 20;

  const FIELD_MAP = {
    body_mismatch:     { label: 'Body',        bg: '#FEF3C7', fg: '#92400E' },
    body_empty:        { label: 'Body',        bg: '#FEF3C7', fg: '#92400E' },
    body_text_missing: { label: 'Body',        bg: '#FEF3C7', fg: '#92400E' },
    subject:           { label: 'Subject',     bg: '#EFF6FF', fg: '#1E40AF' },
    attachments:       { label: 'Attachments', bg: '#F5F3FF', fg: '#5B21B6' },
    recipients:        { label: 'Headers',     bg: '#F1F5F9', fg: '#475569' },
    folder_flag:       { label: 'Folder',      bg: '#ECFDF5', fg: '#065F46' },
    network:           { label: 'Network',     bg: '#EFF6FF', fg: '#1E40AF' },
  };

  for (const pair of pairFailures) {
    ensureSpace(doc, PH_H + HDR_H + ROW_H * Math.min(pair.failures.length, 3) + 14);

    let y = doc.y;
    doc.save().fillColor('#2D4A63').rect(MARGIN, y, FI_W, PH_H).fill().restore();
    doc.fontSize(8).font(F_BOLD).fillColor('#FFFFFF')
      .text(pair.src, MARGIN + 8, y + 5, { width: FI_W / 2 - 10, lineBreak: false });
    doc.fontSize(8).font(F_REGULAR).fillColor('#7CA0BB')
      .text(`  →  ${pair.dst}`, MARGIN + 8 + FI_W / 2 - 10, y + 5, { width: FI_W / 2 - 60, lineBreak: false });
    const fcLabel = `${pair.failures.length} failure${pair.failures.length !== 1 ? 's' : ''}`;
    doc.save().fillColor(C.failBg).roundedRect(MARGIN + FI_W - 66, y + 3, 60, 14, 3).fill().restore();
    doc.fontSize(7.5).font(F_BOLD).fillColor(C.fail)
      .text(fcLabel, MARGIN + FI_W - 66, y + 5, { width: 60, align: 'center', lineBreak: false });
    y += PH_H;

    doc.save().fillColor('#F1F5F9').rect(MARGIN, y, FI_W, HDR_H).fill().restore();
    doc.save().strokeColor('#CBD5E1').lineWidth(0.5)
      .moveTo(MARGIN, y + HDR_H).lineTo(MARGIN + FI_W, y + HDR_H).stroke().restore();
    let hx = MARGIN;
    doc.fontSize(7.5).font(F_BOLD).fillColor(C.muted);
    FI_COLS.forEach((c) => {
      doc.text(c.label.toUpperCase(), hx + 5, y + 5, { width: c.w - 10, lineBreak: false });
      hx += c.w;
    });
    y += HDR_H;

    for (const r of pair.failures) {
      ensureSpace(doc, ROW_H + 2);
      y = doc.y;

      const reason     = classifyDeepMailReason(r);
      const fc         = FIELD_MAP[reason.key] || { label: 'Other', bg: '#F1F5F9', fg: '#475569' };
      const folderDiff = (r.diffs || []).find((d) => String(d.field || '').toLowerCase() === 'folder');
      const folderStr  = r.sourceFolder || r.folder || r.sourceFolderName ||
                         (folderDiff ? String(folderDiff.expected || '—') : '—');

      const structRows = structuredRowsForDeepPdfRow(r);
      let issueDetail = reason.label;
      if (['body_mismatch', 'body_empty', 'body_text_missing'].includes(reason.key)) {
        const bodyRow = structRows.find((s) => String(s.fieldKey || s.fieldLabel || '').toLowerCase() === 'body');
        if (bodyRow) {
          const srcLen = String(bodyRow.sourceExpected || '').length;
          const dstLen = String(bodyRow.destinationActual || '').length;
          if (srcLen > 0 || dstLen > 0)
            issueDetail = `src: ${srcLen.toLocaleString()} chars  →  dst: ${dstLen.toLocaleString()} chars`;
        }
      }

      doc.save().fillColor('#FEF8F8').rect(MARGIN, y, FI_W, ROW_H).fill().restore();
      doc.save().strokeColor(C.border).lineWidth(0.3)
        .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + FI_W, y + ROW_H).stroke().restore();

      let rx = MARGIN;
      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
        .text(truncateRef(folderStr, 18), rx + 5, y + 9, { width: FI_COLS[0].w - 10, lineBreak: false });
      rx += FI_COLS[0].w;

      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.dark)
        .text(truncateRef(String(r.subject || '(no subject)'), 40), rx + 5, y + 9, { width: FI_COLS[1].w - 10, lineBreak: false });
      rx += FI_COLS[1].w;

      const fbW = FI_COLS[2].w - 10;
      doc.save().fillColor(fc.bg).roundedRect(rx + 3, y + 8, fbW, 13, 2).fill().restore();
      doc.fontSize(7).font(F_BOLD).fillColor(fc.fg)
        .text(fc.label, rx + 3, y + 10, { width: fbW, align: 'center', lineBreak: false });
      rx += FI_COLS[2].w;

      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.dark)
        .text(issueDetail, rx + 5, y + 5, { width: FI_COLS[3].w - 10, lineGap: 1 });

      doc.y = y + ROW_H;
    }

    doc.save().strokeColor(C.border).lineWidth(0.5)
      .moveTo(MARGIN, doc.y).lineTo(MARGIN + FI_W, doc.y).stroke().restore();
    doc.moveDown(0.8);
  }
}

// ── Pair divider band (slim slate strip, replaces repeated full header) ────────
function drawPairDividerBand(doc, pairIndex, totalPairs, execution, status) {
  const src   = execution.context?.sourceEmail || '—';
  const dst   = execution.context?.destinationEmail || '—';
  const bandH = 28;

  doc.save().fillColor('#2D4A63').rect(0, 0, PAGE_WIDTH, bandH).fill().restore();

  doc.fontSize(7).font(F_BOLD).fillColor('#92B5CC')
    .text(`PAIR ${pairIndex} OF ${totalPairs}`, MARGIN, 9, { width: 68, lineBreak: false });

  const routeW = CONTENT_W - 68 - 58;
  doc.fontSize(8.5).font(F_BOLD).fillColor('#FFFFFF')
    .text(`${src}  →  ${dst}`, MARGIN + 72, 9, { width: routeW, lineBreak: false });

  const isFail = status === 'FAIL';
  const tagW   = 44;
  const tagX   = PAGE_WIDTH - MARGIN - tagW;
  doc.save().fillColor(isFail ? C.failBg : C.passBg).roundedRect(tagX, 6, tagW, 16, 3).fill().restore();
  doc.fontSize(8).font(F_BOLD).fillColor(isFail ? C.fail : C.pass)
    .fillColor(isFail ? C.fail : C.pass);
  drawFitted(doc, status, tagX, 9, tagW, { align: 'center' });

  doc.y = bandH + 6;
}

// ── Bulk cover page (shared, rendered once at the start of a bulk report) ──────
function drawBulkCoverPage(doc, executions) {
  const overallStatus = getBulkOverallStatus(executions);
  const ex0  = executions[0];
  const ctx0 = ex0?.context;
  const genDate = formatTimestamp(new Date());

  doc.save().fillColor(C.dark).rect(0, 0, PAGE_WIDTH, 82).fill().restore();
  doc.fontSize(17).font(F_BOLD).fillColor('#ffffff')
    .text('Migration QA Validation Report', MARGIN, 18, { width: CONTENT_W - 90 });
  doc.fontSize(8.5).font(F_REGULAR).fillColor(C.muted)
    .text(
      `Generated: ${genDate}  ·  Bulk run · ${executions.length} pair${executions.length !== 1 ? 's' : ''}`,
      MARGIN, 45, { width: CONTENT_W - 90 }
    );
  drawStatusBadge(doc, PAGE_WIDTH - MARGIN - 82, 18, overallStatus);

  doc.save().fillColor('#f1f5f9').rect(0, 82, PAGE_WIDTH, 44).fill().restore();

  const combination = (ctx0?.sourceProvider || ctx0?.destinationProvider)
    ? `${providerLabel(ctx0.sourceProvider)} → ${providerLabel(ctx0.destinationProvider)}`
    : `${ctx0?.sourceEmail || '?'} → ${ctx0?.destinationEmail || '?'}`;
  const totalDurationMs = executions.reduce((sum, ex) => sum + (Number(ex.result?.duration) || 0), 0);
  const initiated = ex0?.createdAt ? formatTimestamp(ex0.createdAt) : 'N/A';

  // 6 meta items spread across full width, matching the proposal
  const bulkId    = ex0?.context?.bulkRunId || ex0?.executionId || '—';
  const metaItems = [
    combination,
    `Type: ${ctx0?.testType || 'E2E'}`,
    `Migration: ${ctx0?.migrationType === 'DELTA' ? 'Delta' : 'One-time'}`,
    `Duration: ${totalDurationMs > 0 ? formatDurationMs(totalDurationMs) : 'N/A'}`,
    `Initiated: ${initiated}`,
    `Bulk ID: ${String(bulkId).slice(0, 20)}`,
  ];
  const metaColW = CONTENT_W / metaItems.length;
  doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt);
  metaItems.forEach((item, i) => {
    doc.text(item, MARGIN + i * metaColW, 100, { width: metaColW - 4, lineBreak: false });
  });

  // Start immediately after meta band (ends at y=126) — no large gap
  doc.y = 126;
  doc.moveDown(0.3);
  doc.fontSize(11).font(F_BOLD).fillColor(C.dark).text('Pair Overview', MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.15);
  hRule(doc, doc.y, '#cbd5e1');
  doc.moveDown(0.4);
  drawPairOverviewGrid(doc, executions);
  drawBulkMigrationStatus(doc, executions);
  drawFailureIndex(doc, executions);

  ensureSpace(doc, 30);
  doc.moveDown(0.8);
  hRule(doc, doc.y, '#cbd5e1');
  doc.moveDown(0.3);
  const footY = doc.y;
  doc.fontSize(8).font(F_REGULAR).fillColor(C.muted)
    .text('CloudFuze Migration QA · Bulk Validation Report', MARGIN, footY);
  doc.fontSize(8).font(F_REGULAR).fillColor(C.muted)
    .text('Page 1', MARGIN + CONTENT_W - 50, footY, { width: 50, align: 'right' });
}

// ── CloudFuze Migration Status (before Section 1) ────────────────────────────
function drawMigrationJobSection(doc, context, result) {
  // migrationJobDetails is set on context *during* the run but context is snapshotted at
  // creation time, so it may be missing from the persisted record. Fall back to
  // result.migrationResult and result.validationSummary which are saved after completion.
  const migJob =
    context?.migrationJobDetails ||
    result?.migrationResult?.migrationJobDetails ||
    result?.validationSummary?.migrationJobDetails ||
    null;
  const srcEmail  = context?.sourceEmail      || '—';
  const dstEmail  = context?.destinationEmail || '—';
  const hasData   = migJob || srcEmail !== '—' || dstEmail !== '—';
  if (!hasData) return;

  drawSectionHeader(doc, 'CloudFuze Migration Status');

  // ── Server URL strip ───────────────────────────────────────────────────────
  const serverUrl = String(migJob?.serverUrl || context?.migrationServerUrl || '—');
  if (serverUrl && serverUrl !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Server: ${serverUrl}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }

  // Show real job ID and display name separately so "Job ID" never shows the display name.
  const jobIdReal = String(migJob?.jobId || '—');
  const jobNameStr = String(migJob?.jobName || '—');
  if (jobIdReal && jobIdReal !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job ID: ${jobIdReal}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }
  if (jobNameStr && jobNameStr !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job Name: ${jobNameStr}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
    doc.moveDown(0.35);
  }

  // ── header row ─────────────────────────────────────────────────────────────
  // Total / Processed counts come from the same CF reports API that provides workspaceId
  const totalCount     = migJob?.totalCount     != null ? String(migJob.totalCount)     : '—';
  const processedCount = migJob?.processedCount != null ? String(migJob.processedCount) : '—';

  const COLS = [
    { label: 'Job ID',        w:  95 },
    { label: 'Workspace ID',  w:  78 },
    { label: 'From Email',    w:  85 },
    { label: 'To Email',      w:  85 },
    { label: 'Total',         w:  38 },
    { label: 'Processed',     w:  44 },
    { label: 'CF Status',     w:  CONTENT_W - 95 - 78 - 85 - 85 - 38 - 44 },
  ];
  const TABLE_W = COLS.reduce((s, c) => s + c.w, 0);
  const HDR_H = 22;
  const ROW_H = 28;

  ensureSpace(doc, HDR_H + ROW_H + 20);

  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, TABLE_W, HDR_H).fill().restore();
  let hx = MARGIN;
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  COLS.forEach((c) => {
    drawFitted(doc, c.label, hx + 5, y + 6, c.w - 10);
    hx += c.w;
  });
  doc.save().strokeColor('#94a3b8').lineWidth(0.5)
    .moveTo(MARGIN, y + HDR_H).lineTo(MARGIN + TABLE_W, y + HDR_H).stroke().restore();
  y += HDR_H;

  // ── data row ───────────────────────────────────────────────────────────────
  const jobIdCell   = String(migJob?.jobId || migJob?.jobName || '—');
  const workspaceId = String(migJob?.workspaceId || '—');
  const cfStatusRaw = String(migJob?.cfStatus || '—');
  const cfStatusUp  = cfStatusRaw.toUpperCase();

  // Shorten long status strings so they fit in the badge
  const cfStatusLabel = (() => {
    if (cfStatusUp === 'PROCESSED_WITH_CONFLICTS' || cfStatusUp === 'PROCESS_WITH_CONFLICTS') return 'Proc. w/ Conflicts';
    if (/^PROCESS(ED)?$/.test(cfStatusUp)) return 'Processed';
    if (cfStatusUp === 'COMPLETED')   return 'Completed';
    if (cfStatusUp === 'IN_PROGRESS') return 'In Progress';
    if (cfStatusUp === 'INITIATED')   return 'Initiated';
    if (cfStatusUp === 'FAILED')      return 'Failed';
    if (cfStatusUp === 'CANCELLED')   return 'Cancelled';
    return cfStatusRaw.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  })();

  let statusBg = '#f1f5f9', statusFg = C.subtle;
  if (/^PROCESS(ED)?$/.test(cfStatusUp) || cfStatusUp === 'COMPLETED') {
    statusBg = C.passBg; statusFg = C.pass;
  } else if (cfStatusUp === 'PROCESSED_WITH_CONFLICTS' || cfStatusUp === 'PROCESS_WITH_CONFLICTS') {
    statusBg = C.warnBg; statusFg = C.warn;
  } else if (/FAIL|ERROR/.test(cfStatusUp)) {
    statusBg = C.failBg; statusFg = C.fail;
  } else if (/PROGRESS|INPROG|QUEUE|INIT|RUN/.test(cfStatusUp)) {
    statusBg = '#dbeafe'; statusFg = '#1d4ed8';
  }

  doc.save().fillColor('#fafafa').rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();

  const cells = [
    { text: jobIdCell,      w: COLS[0].w },
    { text: workspaceId,    w: COLS[1].w },
    { text: srcEmail,       w: COLS[2].w },
    { text: dstEmail,       w: COLS[3].w },
    { text: totalCount,     w: COLS[4].w },
    { text: processedCount, w: COLS[5].w },
    { text: null,           w: COLS[6].w },
  ];

  let rx = MARGIN;
  cells.forEach((cell, i) => {
    if (i < cells.length - 1) {
      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.text)
;
      drawFitted(doc, cell.text, rx + 5, y + 9, cell.w - 10);
    } else {
      // Status badge — full width of remaining column
      const tagW = cell.w - 10;
      doc.save().fillColor(statusBg).roundedRect(rx + 5, y + 7, tagW, 16, 3).fill().restore();
      doc.fontSize(7.5).font(F_BOLD).fillColor(statusFg);
      drawFitted(doc, cfStatusLabel, rx + 5, y + 11, tagW, { align: 'center' });
    }
    rx += cell.w;
  });

  doc.save().strokeColor(C.border).lineWidth(0.35)
    .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + TABLE_W, y + ROW_H).stroke().restore();
  y += ROW_H;
  doc.y = y;

  // ── Progress bar ──────────────────────────────────────────────────────────
  const pct = (migJob?.totalCount > 0)
    ? Math.round(((migJob.processedCount || 0) / migJob.totalCount) * 100)
    : null;

  if (pct != null) {
    doc.moveDown(0.4);
    const barY  = doc.y;
    const barW  = CONTENT_W;
    const barH  = 9;
    const fillW = Math.max(4, Math.round(barW * pct / 100));
    const fillColor = pct >= 100 ? C.pass : C.info;

    doc.save().fillColor('#e2e8f0').roundedRect(MARGIN, barY, barW, barH, 4).fill().restore();
    if (pct > 0) {
      doc.save().fillColor(fillColor).roundedRect(MARGIN, barY, fillW, barH, 4).fill().restore();
    }
    doc.fontSize(7.5).font(F_BOLD).fillColor(fillColor)
      .text(`${pct}% migrated`, MARGIN, barY - 14, { width: CONTENT_W, align: 'right', lineBreak: false });
    doc.y = barY + barH + 8;
  }

  // CloudFuze's own per-folder breakdown (from /mail/workSpaces/{workspaceId}) — a cross-check
  // against our folder validation: shows what CloudFuze reports it moved into each folder.
  drawCloudFuzeFolderBreakdown(doc, migJob);

  doc.moveDown(0.6);
}

// CloudFuze per-folder breakdown table (source folder → dest path, per-folder counts + status).
function drawCloudFuzeFolderBreakdown(doc, migJob) {
  const rows = Array.isArray(migJob?.folderBreakdown) ? migJob.folderBreakdown : [];
  if (rows.length === 0) return;

  doc.moveDown(0.5);
  doc.fontSize(9).font(F_BOLD).fillColor(C.dark)
    .text(`CloudFuze Per-Folder Breakdown (${rows.length}) — cross-check vs folder validation`, MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.3);

  const COL_F = CONTENT_W * 0.26;   // source folder
  const COL_D = CONTENT_W * 0.40;   // dest path
  const COL_T = CONTENT_W * 0.09;   // total
  const COL_M = CONTENT_W * 0.09;   // messages
  const COL_S = CONTENT_W - COL_F - COL_D - COL_T - COL_M; // status
  const X1 = MARGIN, X2 = X1 + COL_F, X3 = X2 + COL_D, X4 = X3 + COL_T, X5 = X4 + COL_M;
  const cell = (txt, x, w, yy, opts = {}) =>
    doc.text(String(txt), x, yy, { width: w - 8, height: 9, ellipsis: true, lineBreak: false, ...opts });

  ensureSpace(doc, 18);
  let ty = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, ty, CONTENT_W, 18).fill().restore();
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, ty, CONTENT_W, 18).stroke().restore();
  doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt);
  cell('Source Folder', X1 + 6, COL_F, ty + 4);
  cell('Destination Path', X2 + 4, COL_D, ty + 4);
  cell('Total', X3 + 4, COL_T, ty + 4);
  cell('Msgs', X4 + 4, COL_M, ty + 4);
  cell('Status', X5 + 4, COL_S, ty + 4);
  ty += 18;
  doc.y = ty;

  for (const [i, r] of rows.entries()) {
    ensureSpace(doc, 15);
    ty = doc.y;
    const st = String(r.status || '').toUpperCase();
    const bad = /FAIL|ERROR|CONFLICT/.test(st);
    if (bad) doc.save().fillColor(C.failBg).rect(MARGIN, ty, CONTENT_W, 15).fill().restore();
    else if (i % 2 === 0) doc.save().fillColor('#fafafa').rect(MARGIN, ty, CONTENT_W, 15).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.3).rect(MARGIN, ty, CONTENT_W, 15).stroke().restore();

    doc.fontSize(7).font(F_REGULAR).fillColor(C.text);
    cell(`${r.subFolder ? '  ' : ''}${r.folder}`, X1 + 6, COL_F, ty + 3.5);
    doc.fillColor(C.subtle);
    cell(r.destPath || '—', X2 + 4, COL_D, ty + 3.5);
    doc.fillColor(C.darkAlt);
    cell(r.total ?? '—', X3 + 4, COL_T, ty + 3.5);
    cell(r.messages ?? '—', X4 + 4, COL_M, ty + 3.5);
    doc.font(F_BOLD).fillColor(bad ? C.fail : C.pass);
    cell(r.status || '—', X5 + 4, COL_S, ty + 3.5);
    ty += 15;
    doc.y = ty;
  }
  doc.moveDown(0.3);
  doc.fontSize(7).font(F_ITALIC).fillColor(C.subtle)
    .text('Source: CloudFuze /mail/workSpaces — counts are what CloudFuze reports it migrated per folder.', MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.4);
}

// ── Section 1: Summary metric grid ───────────────────────────────────────────
function drawSummarySection(doc, validation, context, result) {
  drawSectionHeader(doc, '1 — Summary');

  const { deep, results: deepResults } = normalizeDeepMailResultsForPdf(validation);
  const deepFailed = deepResults.filter((r) => !r.pass).length;

  const MAPPED_OUTLOOK = new Set(['Inbox', 'Sent Items', 'Drafts', 'Deleted Items', 'Junk Email']);
  const MAPPED_GMAIL   = new Set(['INBOX', 'SENT', 'DRAFT', 'TRASH', 'SPAM']);
  const srcDefaults = validation.sourceData?.defaultLabels  || [];
  const srcCustoms  = validation.sourceData?.customLabels   || [];
  const dstDefaults = validation.destinationData?.defaultFolders || [];
  const dstCustoms  = validation.destinationData?.customFolders  || [];

  const srcMail = srcDefaults.filter((l) => MAPPED_GMAIL.has(String(l.id ?? l.name ?? '').toUpperCase()))
                    .reduce((s, l) => s + (l.messageCount || 0), 0)
                + srcCustoms.reduce((s, l) => s + (l.messageCount || 0), 0);
  const dstFetchError = validation.destinationData?.fetchError || null;
  const dstMail = dstFetchError ? null
    : dstDefaults.filter((f) => MAPPED_OUTLOOK.has(String(f.name ?? '')))
                    .reduce((s, f) => s + (f.messageCount || 0), 0)
                + dstCustoms.reduce((s, f) => s + (f.messageCount || 0), 0);
  const mailMatch = dstMail !== null && srcMail === dstMail;

  const scanned  = deep.scannedSourceMessages ?? null;
  const paired   = deep.pairedCount           ?? null;
  const unpaired = (scanned != null && paired != null) ? Math.max(0, scanned - paired) : null;

  // Each card: value shown large, label in semi-bold, sub in small gray explaining what it means
  const metrics = [
    {
      value: scanned ?? '—',
      label: 'Emails Checked',
      sub:   'QA source emails examined',
      vc: C.text, bg: C.bg, bd: C.border,
    },
    {
      value: paired ?? '—',
      label: 'Matched in Destination',
      sub:   'Source emails found & paired',
      vc: C.text, bg: C.bg, bd: C.border,
    },
    {
      value: unpaired ?? '—',
      label: 'Not Found in Destination',
      sub:   'Source emails missing from dest',
      vc: unpaired > 0 ? C.fail : C.pass,
      bg: unpaired > 0 ? C.failBg : C.passBg,
      bd: unpaired > 0 ? C.failBorder : C.passBorder,
    },
    {
      value: deepFailed,
      label: 'Content Mismatches',
      sub:   'Paired emails with field differences',
      vc: deepFailed > 0 ? C.fail : C.pass,
      bg: deepFailed > 0 ? C.failBg : C.passBg,
      bd: deepFailed > 0 ? C.failBorder : C.passBorder,
    },
    {
      value: dstFetchError ? `${srcMail} → N/A` : `${srcMail} → ${dstMail}`,
      label: 'Mailbox Email Count',
      sub: dstFetchError
        ? `Dest folder fetch failed: ${dstFetchError.length > 60 ? dstFetchError.slice(0, 57) + '...' : dstFetchError}`
        : 'Total emails: source → destination',
      vc: dstFetchError ? C.warn : (mailMatch ? C.pass : C.fail),
      bg: dstFetchError ? C.warnBg : (mailMatch ? C.passBg : C.failBg),
      bd: dstFetchError ? C.warnBorder : (mailMatch ? C.passBorder : C.failBorder),
    },
    {
      value: result?.duration != null ? formatDurationMs(result.duration) : '—',
      label: 'Total Run Time',
      sub:   'End-to-end execution duration',
      vc: C.text, bg: C.bg, bd: C.border,
    },
  ];

  const gap   = 10;
  const cols  = 3;
  const cardW = (CONTENT_W - gap * (cols - 1)) / cols;
  const cardH = 90; // taller to fit value + label + subtitle

  ensureSpace(doc, cardH * 2 + gap + 16);
  let startY = doc.y;

  metrics.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = MARGIN + col * (cardW + gap);
    const cy  = startY + row * (cardH + gap);

    // Card background + border
    doc.save().fillColor(m.bg).roundedRect(cx, cy, cardW, cardH, 6).fill().restore();
    doc.save().strokeColor(m.bd).lineWidth(1).roundedRect(cx, cy, cardW, cardH, 6).stroke().restore();

    // Large value
    const valStr  = String(m.value ?? '—');
    const valSize = valStr.length > 8 ? 13 : valStr.length > 5 ? 16 : 22;
    doc.fontSize(valSize).font(F_BOLD).fillColor(m.vc)
      .text(valStr, cx + 6, cy + 13, { width: cardW - 12, align: 'center' });

    // Label (semi-bold, readable)
    doc.fontSize(8.5).font(F_BOLD).fillColor(C.text)
      .text(m.label, cx + 6, cy + cardH - 38, { width: cardW - 12, align: 'center' });

    // Subtitle (small gray, explains what the number means)
    doc.fontSize(6.5).font(F_REGULAR).fillColor(C.subtle)
      .text(m.sub, cx + 6, cy + cardH - 22, { width: cardW - 12, align: 'center' });
  });

  doc.y = startY + Math.ceil(metrics.length / cols) * (cardH + gap) + 4;
}

// ── Email Order Validation bar (after Summary metric cards) ───────────────────
// ── Section 2: Functionality Check ────────────────────────────────────────────
// Per-feature pass/fail roll-up against the docs tool's in-scope feature list.
function drawFunctionalityChecklist(doc, validation, context) {
  const checklist = computeFunctionalityChecklist(
    validation,
    context?.sourceProvider,
    context?.destinationProvider,
    { migrationType: context?.migrationType }
  );
  if (!checklist) return;

  drawSectionHeader(doc, '3 — Functionality Check');

  const { pass, fail, na, total } = checklist.counts;
  doc.fontSize(8.5).font(F_REGULAR).fillColor(C.subtle)
    .text(
      `${pass} passed  ·  ${fail} failed  ·  ${na} not validated by this run   ` +
      `(${total} ${checklist.migrationType || ''} features — ${checklist.combination})`,
      MARGIN, doc.y, { width: CONTENT_W }
    );
  doc.moveDown(0.5);

  const ICON_W = 16;
  const NAME_W = CONTENT_W * 0.42;
  const EVID_W = CONTENT_W - ICON_W - NAME_W;
  const colorOf = (s) => (s === 'pass' ? C.pass : s === 'fail' ? C.fail : C.muted);

  // Draw the status mark as a VECTOR shape (not a font glyph): a green check for pass, a red cross
  // for fail, a gray dash for not-validated. The embedded font lacks ✓/✗ glyphs, so text-based
  // icons rendered as empty boxes (□) — vector drawing always renders.
  const drawStatusIcon = (status, x, y) => {
    doc.save().lineWidth(1.4).lineCap('round').lineJoin('round').strokeColor(colorOf(status));
    if (status === 'pass') {
      doc.moveTo(x, y + 5.5).lineTo(x + 3, y + 9).lineTo(x + 8.5, y + 1.5).stroke();
    } else if (status === 'fail') {
      doc.moveTo(x + 1, y + 2).lineTo(x + 8, y + 9).stroke();
      doc.moveTo(x + 8, y + 2).lineTo(x + 1, y + 9).stroke();
    } else {
      doc.moveTo(x, y + 5.5).lineTo(x + 8, y + 5.5).stroke();
    }
    doc.restore();
  };

  // Flat list of feature rows — no family sub-headers (they duplicated feature names and added noise).
  const features = checklist.families.flatMap((fam) => fam.features);
  for (const feat of features) {
    // Evidence WRAPS, up to three lines. It used to be clipped to a single line with an ellipsis,
    // which cut off exactly the sentence a reviewer needs — the reason a feature failed. Three lines
    // holds the explanations this report actually produces without letting one row run a page.
    const evidence = String(feat.evidence || '');
    const EV_LINE = 9.5;
    const EV_MAX_H = EV_LINE * 3;
    const evH = evidence
      ? Math.min(doc.fontSize(7.5).font(F_REGULAR).heightOfString(evidence, { width: EVID_W }), EV_MAX_H)
      : 0;
    const rowH = Math.max(12.5, evH + 3);
    ensureSpace(doc, rowH + 2);
    const ry = doc.y;
    drawStatusIcon(feat.status, MARGIN + 3, ry);
    // The NAME stays one clipped line — feature names are short and a wrapped name would misalign
    // the icon. (PDFKit 0.18 ignores lineBreak:false alone, so height + ellipsis does the clipping.)
    doc.fontSize(8).font(F_REGULAR).fillColor(feat.status === 'na' ? C.subtle : C.text)
      .text(feat.name, MARGIN + ICON_W, ry, { width: NAME_W - 4, height: 10, ellipsis: true, lineBreak: false });
    if (evidence) {
      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.subtle)
        .text(evidence, MARGIN + ICON_W + NAME_W, ry, { width: EVID_W, height: EV_MAX_H, ellipsis: true });
    }
    doc.y = ry + rowH;
  }
  doc.moveDown(0.4);
}

// ── Section 3: Mail Order ──────────────────────────────────────────────────────
function drawEmailOrderSection(doc, validation) {
  const orderVal = validation?.deepMailValidation?.orderValidation;
  if (!orderVal) return;

  drawSectionHeader(doc, '4 — Mail Order');

  const skipped       = orderVal.skipped;
  const pass          = skipped ? null : orderVal.pass;
  const total         = orderVal.totalChecked ?? 0;
  const count         = orderVal.outOfOrderCount ?? 0;
  const folders       = orderVal.foldersChecked ?? 0;
  const items         = orderVal.outOfOrder ?? [];

  // Order is verified within each folder/label — note how many folders were covered.
  const simNote = folders > 0 ? `  (order checked within ${folders} folder(s)/label(s))` : '';

  ensureSpace(doc, 40);
  doc.moveDown(0.5);
  const y = doc.y;
  const barH = 28;

  const barColor = skipped ? C.border    : pass ? C.passBorder : C.warnBorder;
  const barBg    = skipped ? C.surface   : pass ? C.passBg     : C.warnBg;
  const barText  = skipped ? C.subtle    : pass ? C.pass       : C.warn;
  const statusLabel = skipped
    ? `Email Order — Skipped (${orderVal.reason || 'insufficient data'})`
    : pass
      ? `Email Order — PASS  (${total} messages checked${simNote})`
      : `Email Order — ${count} of ${total} message(s) arrived in a different order at destination${simNote}`;

  doc.save().fillColor(barBg).roundedRect(MARGIN, y, CONTENT_W, barH, 4).fill().restore();
  doc.save().strokeColor(barColor).lineWidth(1).roundedRect(MARGIN, y, CONTENT_W, barH, 4).stroke().restore();
  doc.fontSize(9).font(F_BOLD).fillColor(barText)
    .text(statusLabel, MARGIN + 12, y + 9, { width: CONTENT_W - 24, lineBreak: false });
  doc.y = y + barH + 4;

  if (!skipped && !pass && items.length > 0) {
    // Location column headers adapt to platform: Gmail → "Label", Outlook → "Folder"
    const srcHeader  = (orderVal.folderKind     || items[0]?.folderKind)     === 'label' ? 'Source Label'      : 'Source Folder';
    const destHeader = (orderVal.destFolderKind || items[0]?.destFolderKind) === 'label' ? 'Destination Label' : 'Destination Folder';

    // 6-column table: Subject | Source Folder/Label | Dest Folder/Label | Method | Src Pos | Dest Pos
    const COL1 = CONTENT_W * 0.27;
    const COL2 = CONTENT_W * 0.21;
    const COL3 = CONTENT_W * 0.21;
    const COL4 = CONTENT_W * 0.09;
    const COL5 = CONTENT_W * 0.11;
    const COL6 = CONTENT_W - COL1 - COL2 - COL3 - COL4 - COL5;
    const X1 = MARGIN;
    const X2 = X1 + COL1;
    const X3 = X2 + COL2;
    const X4 = X3 + COL3;
    const X5 = X4 + COL4;
    const X6 = X5 + COL5;
    const ROW_H = 18;
    // NOTE: PDFKit 0.18 ignores lineBreak:false when a width is set — long values still wrap and
    // overlap the next fixed-height row. Passing ellipsis:true + a one-line height forces a single
    // clipped line ("…"), so every cell stays inside its row.
    const cell = (txt, x, w, yy, opts = {}) =>
      doc.text(txt, x, yy, { width: w - 8, height: 9, ellipsis: true, lineBreak: false, ...opts });

    ensureSpace(doc, ROW_H);
    let ty = doc.y;
    doc.save().fillColor('#f1f5f9').rect(MARGIN, ty, CONTENT_W, ROW_H).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, ty, CONTENT_W, ROW_H).stroke().restore();
    doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt);
    cell('Email Subject', X1 + 6, COL1, ty + 4);
    cell(srcHeader,       X2 + 4, COL2, ty + 4);
    cell(destHeader,      X3 + 4, COL3, ty + 4);
    cell('Method',        X4 + 4, COL4, ty + 4, { align: 'center' });
    cell('Src Pos',       X5 + 4, COL5, ty + 4, { align: 'center' });
    cell('Dest Pos',      X6 + 4, COL6, ty + 4, { align: 'center' });
    ty += ROW_H;
    doc.y = ty;

    for (const item of items) {
      const subj        = item.subject || '(no subject)';
      const srcLoc      = item.folder || '—';
      const destLoc     = item.destFolder || '—';
      const methodLabel = item.validatedBy === 'subject-sequence' ? 'seq#' : 'time';
      ensureSpace(doc, ROW_H);
      ty = doc.y;
      doc.save().fillColor(C.surface).rect(MARGIN, ty, CONTENT_W, ROW_H).fill().restore();
      doc.save().strokeColor(C.border).lineWidth(0.3).rect(MARGIN, ty, CONTENT_W, ROW_H).stroke().restore();
      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.text);
      cell(subj, X1 + 6, COL1, ty + 4);
      doc.fontSize(7).font(F_REGULAR).fillColor(C.text);
      cell(srcLoc,  X2 + 4, COL2, ty + 5);
      cell(destLoc, X3 + 4, COL3, ty + 5);
      doc.fillColor(C.subtle);
      cell(methodLabel, X4 + 4, COL4, ty + 5, { align: 'center' });
      doc.fontSize(7.5).font(F_BOLD).fillColor(C.warn);
      cell(`#${item.srcPosition}`, X5 + 4, COL5, ty + 4, { align: 'center' });
      cell(`#${item.dstPosition}`, X6 + 4, COL6, ty + 4, { align: 'center' });
      ty += ROW_H;
      doc.y = ty;
    }
    doc.moveDown(0.4);
  }
}

// ── Section 2: Failure breakdown ──────────────────────────────────────────────
function drawFailureBreakdown(doc, validation) {
  const { results } = normalizeDeepMailResultsForPdf(validation);
  const groups = buildDeepMailReasonGroups(results);
  if (groups.length === 0) return;

  drawSectionHeader(doc, '2 — Failure Breakdown');

  for (const g of groups) {
    ensureSpace(doc, 64);
    const y   = doc.y;
    const h   = 54;

    doc.save().fillColor('#fafafa').roundedRect(MARGIN, y, CONTENT_W, h, 5).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.75).roundedRect(MARGIN, y, CONTENT_W, h, 5).stroke().restore();
    doc.save().fillColor(C.fail).rect(MARGIN, y, 4, h).fill().restore();

    doc.fontSize(24).font(F_BOLD).fillColor(C.fail)
      .text(String(g.count), MARGIN + 12, y + 11, { width: 46, align: 'center' });

    const textX = MARGIN + 66;
    const textW = CONTENT_W - 74 - 58;
    doc.fontSize(10).font(F_BOLD).fillColor(C.dark)
      .text(g.label, textX, y + 9, { width: textW });
    doc.fontSize(8.5).font(F_REGULAR).fillColor(C.subtle)
      .text(g.action, textX, y + 25, { width: textW });

    // "Error" tag
    const tagText = 'Error';
    const tagX = MARGIN + CONTENT_W - 50;
    doc.save().fillColor(C.failBg).roundedRect(tagX, y + 18, 44, 14, 3).fill().restore();
    doc.fontSize(7.5).font(F_BOLD).fillColor(C.fail).text(tagText, tagX, y + 20, { width: 44, align: 'center' });

    doc.y = y + h + 8;
  }
}

// ── Folder table helper ───────────────────────────────────────────────────────
function drawFolderTable(doc, rows, supportNested) {
  const COL_W  = [202, 68, 68, 92];
  const TABLE_W = COL_W.reduce((a, b) => a + b, 0);
  const HDR_H   = 22;
  const ROW_H   = 22;

  ensureSpace(doc, HDR_H + ROW_H);

  // Header
  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, TABLE_W, HDR_H).fill().restore();
  const headers = ['Folder / Label', 'Source', 'Destination', 'Status'];
  let hx = MARGIN;
  doc.fontSize(8.5).font(F_BOLD).fillColor(C.darkAlt);
  headers.forEach((h, i) => {
    doc.text(h, hx + 6, y + 6, { width: COL_W[i] - 12, lineBreak: false });
    hx += COL_W[i];
  });
  doc.save().strokeColor('#94a3b8').lineWidth(0.5)
    .moveTo(MARGIN, y + HDR_H).lineTo(MARGIN + TABLE_W, y + HDR_H).stroke().restore();
  y += HDR_H;

  rows.forEach((row, idx) => {
    ensureSpace(doc, ROW_H + 4);
    y = doc.y;

    const isMismatch = row.status === 'Mismatch' || row.status === 'NOT FOUND';
    if (isMismatch) {
      doc.save().fillColor(C.failBg).rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();
    } else if (idx % 2 === 0) {
      doc.save().fillColor('#fafafa').rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();
    }

    // Show the full label PATH with "/" separators (e.g. "QA-Deep-L1/QA-Deep-L2") — that is how
    // Gmail nests labels. (Previously we showed only the leaf with a "↳" prefix, which rendered as
    // an empty box because the embedded font lacks that glyph.) Nested rows are slightly indented.
    const isNested = supportNested && row.nested;
    const label    = row.label || '—';
    const indent   = isNested ? 10 : 0;

    let rx = MARGIN;
    doc.fontSize(8.5).font(F_REGULAR).fillColor(C.text)
      .text(label, rx + 6 + indent, y + 6, { width: COL_W[0] - 12 - indent, height: 11, ellipsis: true, lineBreak: false });
    rx += COL_W[0];

    doc.fillColor(C.subtle)
      .text(String(row.srcCount ?? '—'), rx + 6, y + 6, { width: COL_W[1] - 12, lineBreak: false });
    rx += COL_W[1];

    doc.text(String(row.destCount ?? '—'), rx + 6, y + 6, { width: COL_W[2] - 12, lineBreak: false });
    rx += COL_W[2];

    const { bg: tagBg, fg: tagFg } = statusTagColors(row.status);
    const tagW = 64;
    doc.save().fillColor(tagBg).roundedRect(rx + 6, y + 5, tagW, 13, 3).fill().restore();
    doc.fontSize(7.5).font(F_BOLD).fillColor(tagFg)
      .text(row.status, rx + 6, y + 7, { width: tagW, align: 'center', lineBreak: false });

    doc.save().strokeColor(C.border).lineWidth(0.35)
      .moveTo(MARGIN, y + ROW_H).lineTo(MARGIN + TABLE_W, y + ROW_H).stroke().restore();

    y += ROW_H;
    doc.y = y;
  });

  doc.moveDown(0.5);
}

// ── Section 3: Default folder mapping ────────────────────────────────────────
function drawDefaultFolderMapping(doc, validation) {
  drawSectionHeader(doc, '5 — Default Folder Mapping');
  const rows = buildComparisonRows(
    validation.sourceData.defaultLabels  || [],
    validation.destinationData.defaultFolders || [],
    { INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email' }
  );
  drawFolderTable(doc, rows, false);
}

// ── Section 4: Custom folder mapping ─────────────────────────────────────────
function drawCustomFolderMapping(doc, validation) {
  drawSectionHeader(doc, '6 — Custom Folder Mapping');

  const customRows = (validation.sourceData.customLabels || []).map((src) => {
    const dest  = findDestCustomFolder(validation.destinationData.customFolders || [], src.name);
    const match = dest ? src.messageCount === dest.messageCount : false;
    return {
      label:     src.name,
      srcCount:  src.messageCount,
      destCount: dest ? dest.messageCount : null,
      status:    dest ? (match ? 'Match' : 'Mismatch') : 'NOT FOUND',
      nested:    src.name.includes('/'),
    };
  });

  if (customRows.length === 0) {
    doc.fontSize(9).font(F_REGULAR).fillColor(C.subtle)
      .text('No custom labels on source mailbox.', MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.6);
    return;
  }

  drawFolderTable(doc, customRows, true);

  ensureSpace(doc, 34);
  const ibY = doc.y;
  doc.save().fillColor(C.infoBg).roundedRect(MARGIN, ibY, CONTENT_W, 26, 5).fill().restore();
  doc.save().strokeColor(C.infoBorder).lineWidth(0.75).roundedRect(MARGIN, ibY, CONTENT_W, 26, 5).stroke().restore();
  doc.fontSize(7.5).font(F_ITALIC).fillColor(C.info)
    .text(
      'Note: Custom folder counts are compared after label mapping. Nested folders are shown by their full path with "/" separators (e.g. QA-Parent/QA-Child).',
      MARGIN + 8, ibY + 8, { width: CONTENT_W - 16 }
    );
  doc.y = ibY + 32;
}

// ── Section 5: Advisory warnings ─────────────────────────────────────────────
// ── Section 5: Settings & Rules Validation (Outlook→Outlook only) ─────────────
function drawSettingsValidationSection(doc, validation) {
  const sv = validation?.settingsValidation;
  if (!sv || !sv.available) return;

  drawSectionHeader(doc, '7 — Mailbox Settings Validation');

  // ── 3-column settings overview table ───────────────────────────────────────
  const settings = [
    { label: 'Inbox Rules',              src: sv.inboxRules.sourceCount,          dst: sv.inboxRules.destCount,          missing: sv.inboxRules.missing          },
    { label: 'Conditional Formatting',   src: sv.conditionalFormatting.sourceCount, dst: sv.conditionalFormatting.destCount, missing: sv.conditionalFormatting.missing },
    { label: 'Search Folders',           src: sv.searchFolders.sourceCount,       dst: sv.searchFolders.destCount,       missing: sv.searchFolders.missing       },
  ];

  const COL_LABEL = 180, COL_SRC = 90, COL_DST = 90, COL_STATUS = CONTENT_W - COL_LABEL - COL_SRC - COL_DST;
  const ROW_H = 22;
  ensureSpace(doc, (settings.length + 1) * ROW_H + 60);

  // Header row
  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, ROW_H).fill().restore();
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, y, CONTENT_W, ROW_H).stroke().restore();
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  doc.text('Setting',       MARGIN + 6,                              y + 6, { width: COL_LABEL - 6,  lineBreak: false });
  doc.text('Source (QA)',   MARGIN + COL_LABEL,                      y + 6, { width: COL_SRC,        lineBreak: false });
  doc.text('Destination',   MARGIN + COL_LABEL + COL_SRC,            y + 6, { width: COL_DST,        lineBreak: false });
  doc.text('Status',        MARGIN + COL_LABEL + COL_SRC + COL_DST,  y + 6, { width: COL_STATUS - 6, lineBreak: false });
  y += ROW_H;

  for (const [i, row] of settings.entries()) {
    const ok    = row.missing.length === 0;
    const rowBg = ok ? (i % 2 === 0 ? '#ffffff' : '#f8fafc') : C.failBg;
    doc.save().fillColor(rowBg).rect(MARGIN, y, CONTENT_W, ROW_H).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.3).rect(MARGIN, y, CONTENT_W, ROW_H).stroke().restore();
    if (!ok) {
      doc.save().fillColor(C.fail).rect(MARGIN, y, 3, ROW_H).fill().restore();
    }
    const statusLabel = row.src === 0 ? 'N/A' : ok ? 'Migrated' : `${row.missing.length} Missing`;
    const statusColor = row.src === 0 ? C.subtle : ok ? C.pass : C.fail;

    doc.fontSize(8).font(F_REGULAR).fillColor(C.dark)
      .text(row.label,      MARGIN + 6,                              y + 6, { width: COL_LABEL - 6,  lineBreak: false });
    doc.fillColor(C.darkAlt)
      .text(String(row.src), MARGIN + COL_LABEL,                     y + 6, { width: COL_SRC - 4,    lineBreak: false });
    doc.text(String(row.dst), MARGIN + COL_LABEL + COL_SRC,          y + 6, { width: COL_DST - 4,    lineBreak: false });
    doc.font(F_BOLD).fillColor(statusColor)
      .text(statusLabel,    MARGIN + COL_LABEL + COL_SRC + COL_DST,  y + 6, { width: COL_STATUS - 6, lineBreak: false });
    y += ROW_H;

    if (row.missing.length > 0) {
      for (const name of row.missing) {
        ensureSpace(doc, 16);
        const my = doc.y;
        doc.save().fillColor('#fff5f5').rect(MARGIN, my, CONTENT_W, 15).fill().restore();
        doc.save().fillColor(C.fail).rect(MARGIN, my, 3, 15).fill().restore();
        doc.fontSize(7).font(F_ITALIC).fillColor(C.fail)
          .text(`Missing: ${name}`, MARGIN + 10, my + 3, { width: CONTENT_W - 16, lineBreak: false });
        doc.y = my + 15;
        y = doc.y;
      }
    }
  }
  doc.y = y;
  doc.moveDown(0.8);

  // ── Mailbox checks (section emails) — only for O→O runs ─────────────────
  // Skip when settingsValidation is not available (e.g. O→G, G→O, SMOKE runs)
  if (!sv.available) return;

  doc.fontSize(9).font(F_BOLD).fillColor(C.dark).text('Test Email Verification', MARGIN, doc.y);
  doc.moveDown(0.3);

  const checks = Object.values(sv.mailboxChecks || {});
  if (checks.length === 0) {
    doc.fontSize(8).font(F_ITALIC).fillColor(C.subtle).text('No mailbox checks available.', MARGIN, doc.y);
    doc.moveDown(0.5);
    return;
  }

  const CHK_H = 22;
  ensureSpace(doc, (checks.length + 1) * CHK_H + 10);
  y = doc.y;

  // Header
  const CHK_LABEL = CONTENT_W - 80 - 80 - 80;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, CHK_H).fill().restore();
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, y, CONTENT_W, CHK_H).stroke().restore();
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  doc.text('Section',  MARGIN + 6,               y + 6, { width: CHK_LABEL - 6, lineBreak: false });
  doc.text('Expected', MARGIN + CHK_LABEL,        y + 6, { width: 80 - 4,        lineBreak: false });
  doc.text('Found',    MARGIN + CHK_LABEL + 80,   y + 6, { width: 80 - 4,        lineBreak: false });
  doc.text('Status',   MARGIN + CHK_LABEL + 160,  y + 6, { width: 80 - 6,        lineBreak: false });
  y += CHK_H;

  for (const [i, chk] of checks.entries()) {
    const pass  = chk.found >= chk.total;
    const rowBg = pass ? (i % 2 === 0 ? '#ffffff' : '#f8fafc') : C.failBg;
    doc.save().fillColor(rowBg).rect(MARGIN, y, CONTENT_W, CHK_H).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.3).rect(MARGIN, y, CONTENT_W, CHK_H).stroke().restore();
    if (!pass) {
      doc.save().fillColor(C.fail).rect(MARGIN, y, 3, CHK_H).fill().restore();
    }
    const statusLabel = pass ? 'All Found' : `${chk.total - chk.found} Missing`;
    const statusColor = pass ? C.pass : C.fail;

    doc.fontSize(8).font(F_REGULAR).fillColor(C.dark)
      .text(chk.label || '',          MARGIN + 6,              y + 6, { width: CHK_LABEL - 6, lineBreak: false });
    doc.fillColor(C.darkAlt)
      .text(String(chk.total),        MARGIN + CHK_LABEL,      y + 6, { width: 80 - 4,        lineBreak: false });
    doc.text(String(chk.found),       MARGIN + CHK_LABEL + 80, y + 6, { width: 80 - 4,        lineBreak: false });
    doc.font(F_BOLD).fillColor(statusColor)
      .text(statusLabel,              MARGIN + CHK_LABEL + 160, y + 6, { width: 80 - 6,        lineBreak: false });
    y += CHK_H;
  }
  doc.y = y;
  doc.moveDown(0.6);
}

// Builds helpers to decide whether a message's SOURCE folder is missing at the destination
// (its folder did not migrate) vs present. Shared by the "Not Found in Destination" section and
// the "Key Issues" section so both agree on the root cause. A default folder (Inbox/Sent/…) is
// always considered present (it maps to a well-known Gmail label); a custom folder is present if
// its leaf name exists among the destination custom folders.
function buildFolderMissingChecker(validation) {
  const normLeaf = (p) => String(p || '').split('/').map((s) => s.trim().toLowerCase()).filter(Boolean).pop() || '';
  const dstCustom = validation.destinationData?.customFolders || validation.destinationData?.customLabels || [];
  const dstCustomLeaves = new Set(dstCustom.map((f) => normLeaf(f.name)));
  const DEFAULTS = new Set(['inbox', 'sent', 'sent items', 'sentitems', 'drafts', 'junk', 'junk email', 'spam', 'deleted items', 'trash', 'archive', 'bin']);
  const folderOf = (r) => {
    const d = (r.diffs || []).find((x) => x.field === 'folder');
    return d && d.displaySource ? d.displaySource : (r._srcFolder || '');
  };
  const isMissingPath = (srcFolder) => {
    if (!srcFolder) return false;
    const leaf = normLeaf(srcFolder);
    if (DEFAULTS.has(String(srcFolder).trim().toLowerCase()) || DEFAULTS.has(leaf)) return false;
    return !dstCustomLeaves.has(leaf);
  };
  // A not-found result whose source folder is missing at destination — its folder didn't migrate.
  const isResultFolderMissing = (r) => !r.destMessageId && isMissingPath(folderOf(r));
  return { folderOf, isMissingPath, isResultFolderMissing };
}

// ── Section 7: Not Found in Destination ───────────────────────────────────────
// Lists every source email that had no matching message at the destination, with the
// source folder/label it came from. Skipped entirely when all source emails were found.
function drawNotFoundInDestination(doc, validation, context) {
  const results = Array.isArray(validation?.deepMailValidation?.messageResults)
    ? validation.deepMailValidation.messageResults : [];
  const notFound = results.filter((r) => !r.destMessageId);
  if (notFound.length === 0) return;

  const srcIsGmail = /google|gmail/i.test(String(context?.sourceProvider || ''));
  const locHeader = srcIsGmail ? 'Source Label' : 'Source Folder';

  // Tell "the folder itself is missing" (root cause) from "folder exists but this message is missing".
  const { folderOf, isMissingPath } = buildFolderMissingChecker(validation);
  const folderMissing = (srcFolder) => isMissingPath(srcFolder);

  // Distinct source folders that are missing at destination (root cause of their mails not migrating).
  const missingFolders = [...new Set(
    notFound.map(folderOf).filter((f) => folderMissing(f))
  )];

  drawSectionHeader(doc, `7 — Not Found in Destination (${notFound.length} message${notFound.length !== 1 ? 's' : ''})`);
  doc.fontSize(8).font(F_ITALIC).fillColor(C.subtle)
    .text('Source emails with no matching message at the destination.', MARGIN, doc.y, { width: CONTENT_W, lineGap: 2 });
  doc.moveDown(0.4);

  // Root-cause callout FIRST: folders that did not migrate — their emails cannot exist at destination.
  // The missing folders are FULL PATHS (e.g. QA-Nested-Level-01/…/Level-15). Listing them verbatim
  // repeats every shared ancestor and produces an unreadable run-on string, so instead collapse the
  // overlapping paths into a single indented hierarchy that mirrors the source folder tree.
  if (missingFolders.length > 0) {
    const splitPath = (p) => String(p || '').split('/').map((s) => s.trim()).filter(Boolean);
    const treeRoot = new Map();
    for (const fp of missingFolders) {
      let node = treeRoot;
      for (const seg of splitPath(fp)) {
        if (!node.has(seg)) node.set(seg, new Map());
        node = node.get(seg);
      }
    }
    const treeLines = [];
    (function walk(node, depth) {
      for (const [name, child] of node) {
        treeLines.push({ depth, name });
        walk(child, depth + 1);
      }
    })(treeRoot, 0);

    const headerText =
      `${treeLines.length} folder(s) are MISSING at the destination (did not migrate) — ` +
      `emails inside them cannot be found:`;
    const HDR_FS = 8, LINE_FS = 7.5, LINE_H = 11, INDENT = 12, PAD = 6;
    const hdrH = doc.heightOfString(headerText, { width: CONTENT_W - 16 });
    const boxH = PAD + hdrH + 4 + treeLines.length * LINE_H + PAD;

    ensureSpace(doc, boxH + 8);
    const cy = doc.y;
    doc.save().fillColor(C.warnBg).roundedRect(MARGIN, cy, CONTENT_W, boxH, 4).fill().restore();
    doc.save().strokeColor(C.warnBorder).lineWidth(0.75).roundedRect(MARGIN, cy, CONTENT_W, boxH, 4).stroke().restore();

    doc.fontSize(HDR_FS).font(F_BOLD).fillColor(C.warn)
      .text(headerText, MARGIN + 8, cy + PAD, { width: CONTENT_W - 16 });

    let ly = cy + PAD + hdrH + 4;
    doc.fontSize(LINE_FS).font(F_REGULAR).fillColor(C.warn);
    for (const { depth, name } of treeLines) {
      const x = MARGIN + 8 + depth * INDENT;
      // Depth is shown by indentation; use an ASCII connector ("- ") for children — the "↳" glyph
      // is not in the embedded font and rendered as an empty box.
      const prefix = depth === 0 ? '' : '- ';
      doc.text(`${prefix}${name}`, x, ly, { width: CONTENT_W - 16 - depth * INDENT, height: LINE_H - 1, ellipsis: true, lineBreak: false });
      ly += LINE_H;
    }
    doc.y = cy + boxH + 6;
  }

  const COL1 = CONTENT_W * 0.44;
  const COL2 = CONTENT_W * 0.32;
  const COL3 = CONTENT_W - COL1 - COL2;
  const X1 = MARGIN;
  const X2 = X1 + COL1;
  const X3 = X2 + COL2;
  const cell = (txt, x, w, yy, opts = {}) =>
    doc.text(txt, x, yy, { width: w - 8, height: 9, ellipsis: true, lineBreak: false, ...opts });

  // Show only the actual (leaf) folder each mail lives in, with a "…/" prefix when it is nested,
  // so the narrow column never truncates mid-path (which made Level-12 vs Level-15 indistinguishable).
  // The full ancestry is already shown once in the hierarchy tree callout above.
  const leafLabel = (path) => {
    const segs = String(path || '').split('/').map((s) => s.trim()).filter(Boolean);
    if (segs.length === 0) return '—';
    if (segs.length === 1) return segs[0];
    return `…/${segs[segs.length - 1]}`;
  };

  ensureSpace(doc, 18);
  let ty = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, ty, CONTENT_W, 18).fill().restore();
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, ty, CONTENT_W, 18).stroke().restore();
  doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt);
  cell('Email Subject', X1 + 6, COL1, ty + 4);
  cell(locHeader, X2 + 4, COL2, ty + 4);
  cell('Reason', X3 + 4, COL3, ty + 4);
  ty += 18;
  doc.y = ty;

  for (const r of notFound) {
    const loc = leafLabel(folderOf(r));
    const isFolderMissing = folderMissing(folderOf(r));
    ensureSpace(doc, 16);
    ty = doc.y;
    doc.save().fillColor(C.surface).rect(MARGIN, ty, CONTENT_W, 16).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.3).rect(MARGIN, ty, CONTENT_W, 16).stroke().restore();
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.text);
    cell(r.subject || '(no subject)', X1 + 6, COL1, ty + 4);
    doc.fontSize(7).font(F_REGULAR).fillColor(C.subtle);
    cell(loc, X2 + 4, COL2, ty + 4);
    doc.fontSize(7).font(F_REGULAR).fillColor(isFolderMissing ? C.warn : C.subtle);
    cell(isFolderMissing ? 'Folder missing at destination' : 'Message not found', X3 + 4, COL3, ty + 4);
    ty += 16;
    doc.y = ty;
  }
  doc.moveDown(0.4);
}

function drawAdvisoryWarnings(doc, validation) {
  const { results } = normalizeDeepMailResultsForPdf(validation);
  const warned = results.filter((r) => r.pass && (r.diffs || []).some((d) => d.ok === false));
  if (warned.length === 0) return;

  drawSectionHeader(doc, `8 — Advisory Warnings (${warned.length})`);
  doc.fontSize(8).font(F_ITALIC).fillColor(C.subtle)
    .text(
      'These messages passed core validation but have informational differences that do not affect the overall pass/fail result.',
      MARGIN, doc.y, { width: CONTENT_W, lineGap: 2 }
    );
  doc.moveDown(0.5);

  for (const r of warned) {
    const warnDiffs = (r.diffs || []).filter((d) => d.ok === false).slice(0, 5);
    const itemH = 18 + warnDiffs.length * 16 + 6;
    ensureSpace(doc, itemH + 8);

    const y    = doc.y;
    const subj = String(r.subject || '(no subject)').trim();

    // Subject bar
    doc.save().fillColor(C.warnBg).roundedRect(MARGIN, y, CONTENT_W, 18, 4).fill().restore();
    doc.save().fillColor(C.warn).rect(MARGIN, y, 4, 18).fill().restore();
    doc.fontSize(9).font(F_BOLD).fillColor(C.dark)
      .text(subj, MARGIN + 10, y + 4, { width: CONTENT_W - 18, lineBreak: false });

    // Diff rows
    let dy = y + 20;
    for (const d of warnDiffs) {
      doc.save().fillColor('#fafafa').rect(MARGIN, dy, CONTENT_W, 15).fill().restore();
      doc.save().strokeColor(C.border).lineWidth(0.3)
        .rect(MARGIN, dy, CONTENT_W, 15).stroke().restore();
      doc.save().fillColor(C.warn).rect(MARGIN, dy, 4, 15).fill().restore();

      const fieldLabel = String(d.field || d.fieldKey || '');
      const srcVal  = truncatePdfCell(d.expected || d.sourceExpected  || '—', 90);
      const dstVal  = truncatePdfCell(d.actual   || d.destinationActual || '—', 90);
      const midW = (CONTENT_W - 90) / 2 - 4;

      doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt)
        .text(fieldLabel, MARGIN + 8, dy + 3, { width: 84, lineBreak: false });
      doc.font(F_REGULAR).fillColor(C.subtle)
        .text(srcVal, MARGIN + 96, dy + 3, { width: midW, lineBreak: false });
      doc.fillColor(C.muted)
        .text('→', MARGIN + 96 + midW + 2, dy + 3, { width: 12, lineBreak: false });
      doc.fillColor(C.warn)
        .text(dstVal, MARGIN + 96 + midW + 16, dy + 3, { width: midW, lineBreak: false });

      dy += 15;
    }

    doc.y = dy + 8;
  }
}

// ── Section 6: Key issues (per-message failures) ──────────────────────────────
function drawKeyIssues(doc, validation) {
  const { results } = normalizeDeepMailResultsForPdf(validation);
  // Exclude mails that are "not found" ONLY because their folder didn't migrate — those are already
  // explained in the "Not Found in Destination" section under the missing folder (root cause), so
  // repeating them here as per-message failures is redundant noise.
  const { isResultFolderMissing } = buildFolderMissingChecker(validation);
  const failed = results.filter((r) => !r.pass && !isResultFolderMissing(r));

  const bugCount   = failed.filter((r) => r.bugStatus !== 'known_limitation').length;
  const limitCount = failed.filter((r) => r.bugStatus === 'known_limitation').length;
  const issueLabel = failed.length === 0
    ? '9 — Key Issues'
    : limitCount > 0
      ? `9 — Key Issues (${bugCount} bug${bugCount !== 1 ? 's' : ''}, ${limitCount} known limitation${limitCount !== 1 ? 's' : ''})`
      : `9 — Key Issues (${bugCount} failed)`;
  drawSectionHeader(doc, issueLabel);

  if (failed.length === 0) {
    ensureSpace(doc, 40);
    const y = doc.y;
    doc.save().fillColor(C.passBg).roundedRect(MARGIN, y, CONTENT_W, 32, 6).fill().restore();
    doc.save().strokeColor(C.passBorder).lineWidth(1).roundedRect(MARGIN, y, CONTENT_W, 32, 6).stroke().restore();
    doc.fontSize(10).font(F_BOLD).fillColor(C.pass)
      .text('All scanned and paired messages passed deep field comparison.', MARGIN + 12, y + 10, { width: CONTENT_W - 24 });
    doc.y = y + 38;
    return;
  }

  doc.fontSize(8).font(F_ITALIC).fillColor(C.subtle)
    .text('Each card shows a failed message with field-level diffs between source and destination.', MARGIN, doc.y, { width: CONTENT_W, lineGap: 2 });
  doc.moveDown(0.4);

  for (const r of failed) {
    const reason    = classifyDeepMailReason(r);
    const isKnownLimit = r.bugStatus === 'known_limitation';
    const severity  = isKnownLimit ? 'known_limitation' : (reason.severity || 'warning');
    const accentCol = isKnownLimit ? '#6b7280' : severity === 'critical' ? C.fail : severity === 'warning' ? C.warn : C.muted;
    const tagBg     = isKnownLimit ? '#e5e7eb' : severity === 'critical' ? C.failBg : severity === 'warning' ? C.warnBg : '#f1f5f9';
    const tagFg     = isKnownLimit ? '#374151' : severity === 'critical' ? C.fail   : severity === 'warning' ? C.warn   : C.subtle;
    const subj = String(r.subject || '(no subject)').trim();
    const ref  = truncateRef(r.internetMessageId || r.sourceMessageId || '—', 80);
    const rows = structuredRowsForDeepPdfRow(r);

    ensureSpace(doc, 80);

    // Card header
    const cardHdrH = 36;
    const y = doc.y;
    doc.save().fillColor('#fafafa').roundedRect(MARGIN, y, CONTENT_W, cardHdrH, 5).fill().restore();
    doc.save().strokeColor(accentCol).lineWidth(1).roundedRect(MARGIN, y, CONTENT_W, cardHdrH, 5).stroke().restore();
    doc.save().fillColor(accentCol).rect(MARGIN, y, 5, cardHdrH).fill().restore();

    // Severity tag
    const tagLabel = isKnownLimit ? 'KNOWN LIMIT' : severity.toUpperCase();
    const tagW     = isKnownLimit ? 76 : 54;
    doc.save().fillColor(tagBg).roundedRect(MARGIN + CONTENT_W - tagW - 10, y + 10, tagW, 14, 3).fill().restore();
    doc.fontSize(7.5).font(F_BOLD).fillColor(tagFg)
      .text(tagLabel, MARGIN + CONTENT_W - tagW - 10, y + 12, { width: tagW, align: 'center' });

    doc.fontSize(9.5).font(F_BOLD).fillColor(C.dark)
      .text(subj, MARGIN + 12, y + 7, { width: CONTENT_W - tagW - 30, lineBreak: false });
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(ref,  MARGIN + 12, y + 22, { width: CONTENT_W - 24, lineBreak: false });

    doc.y = y + cardHdrH;

    // Field comparison rows
    if (rows.length > 0) {
      drawIssueFieldRows(doc, rows, accentCol);
    } else {
      const noteY = doc.y;
      doc.save().fillColor(C.surface).roundedRect(MARGIN, noteY, CONTENT_W, 22, 5).fill().restore();
      doc.save().strokeColor(accentCol).lineWidth(1).roundedRect(MARGIN, noteY, CONTENT_W, 22, 5).stroke().restore();
      doc.save().fillColor(accentCol).rect(MARGIN, noteY, 5, 22).fill().restore();
      doc.fontSize(8).font(F_ITALIC).fillColor(accentCol)
        .text(String(r.note || 'No diff details recorded.'), MARGIN + 12, noteY + 5, { width: CONTENT_W - 22 });
      doc.y = noteY + 28;
    }

    doc.moveDown(0.6);
  }
}

function drawIssueFieldRows(doc, rows, accentColor) {
  const FIELD_W = 90;
  const SRC_W   = Math.floor((CONTENT_W - FIELD_W) / 2) - 2;
  const DST_W   = SRC_W;

  // Sub-table header
  ensureSpace(doc, 20);
  let y = doc.y;
  doc.save().fillColor('#f8fafc').rect(MARGIN, y, CONTENT_W, 18).fill().restore();
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, y, CONTENT_W, 18).stroke().restore();
  doc.save().fillColor(accentColor).rect(MARGIN, y, 5, 18).fill().restore();
  doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt);
  doc.text('Field',       MARGIN + 8,              y + 4, { width: FIELD_W - 10, lineBreak: false });
  doc.text('Source',      MARGIN + FIELD_W + 4,    y + 4, { width: SRC_W  - 8,  lineBreak: false });
  doc.text('Destination', MARGIN + FIELD_W + SRC_W + 4, y + 4, { width: DST_W - 8, lineBreak: false });
  y += 18;
  doc.y = y;

  for (const row of rows) {
    const sev   = row.severity || 'error';
    const valCol = sev === 'error' ? C.fail : sev === 'warning' ? C.warn : C.text;
    const bodyMax = String(row.fieldLabel || row.fieldKey || '') === 'Body' ? 2200 : 950;
    const fld  = String(row.fieldLabel || row.fieldKey || '');
    const srcT = truncatePdfCell(row.sourceExpected,    bodyMax);
    const dstT = truncatePdfCell(row.destinationActual, bodyMax);

    doc.fontSize(8);
    let maxH = 12;
    maxH = Math.max(maxH,
      doc.heightOfString(fld,  { width: FIELD_W - 10 }),
      doc.heightOfString(srcT, { width: SRC_W   - 8  }),
      doc.heightOfString(dstT, { width: DST_W   - 8  })
    );
    const rowH = maxH + 10;

    ensureSpace(doc, rowH + 2);
    y = doc.y;

    doc.save().fillColor(C.surface).rect(MARGIN, y, CONTENT_W, rowH).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.35).rect(MARGIN, y, CONTENT_W, rowH).stroke().restore();
    doc.save().fillColor(accentColor).rect(MARGIN, y, 5, rowH).fill().restore();

    doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt)
      .text(fld, MARGIN + 8, y + 5, { width: FIELD_W - 10, lineGap: 1 });
    doc.fontSize(8).font(F_REGULAR).fillColor(valCol)
      .text(srcT, MARGIN + FIELD_W + 4, y + 5, { width: SRC_W - 8, lineGap: 1 });
    doc.fillColor(valCol)
      .text(dstT, MARGIN + FIELD_W + SRC_W + 4, y + 5, { width: DST_W - 8, lineGap: 1 });

    y += rowH;
    doc.y = y;
  }

  // Close border around entire card body
  doc.moveDown(0.2);
}

// ── Footer ────────────────────────────────────────────────────────────────────
function drawFooter(doc, context) {
  ensureSpace(doc, 50);
  doc.moveDown(1);
  hRule(doc, doc.y, '#cbd5e1');
  doc.moveDown(0.35);
  const y = doc.y;
  doc.fontSize(8).font(F_REGULAR).fillColor(C.muted)
    .text('CloudFuze QA Agent  •  v1.0', MARGIN, y);
  if (context?.runBy) {
    doc.text(`Run by: ${context.runBy}`, MARGIN, y + 13);
  }
  doc.text(`Generated: ${formatTimestamp(new Date())}`, MARGIN + CONTENT_W - 200, y, { width: 200, align: 'right' });
}

// ── Message Migration PDF Sections ────────────────────────────────────────────

function severityColors(severity) {
  if (severity === 'CRITICAL') return { bg: '#fef2f2', fg: '#dc2626', border: '#fca5a5' };
  if (severity === 'HIGH')     return { bg: '#fff7ed', fg: '#c2410c', border: '#fed7aa' };
  if (severity === 'MEDIUM')   return { bg: '#fffbeb', fg: '#b45309', border: '#fde68a' };
  return { bg: '#f8fafc', fg: '#475569', border: '#cbd5e1' };
}

function drawMsgMetricCards(doc, labels, values, colors) {
  const n = labels.length;
  const cardW = Math.floor((CONTENT_W - (n - 1) * 8) / n);
  const cardH = 52;
  ensureSpace(doc, cardH + 20);
  const startY = doc.y;

  for (let i = 0; i < n; i++) {
    const x = MARGIN + i * (cardW + 8);
    const y = startY;
    const { bg, border } = colors[i] || { bg: '#f8fafc', border: '#e2e8f0' };
    doc.save().fillColor(bg).roundedRect(x, y, cardW, cardH, 5).fill().restore();
    doc.save().strokeColor(border).lineWidth(0.75).roundedRect(x, y, cardW, cardH, 5).stroke().restore();
    doc.fontSize(7).font(F_REGULAR).fillColor(C.subtle)
      .text(labels[i], x + 8, y + 7, { width: cardW - 16, align: 'left' });
    doc.fontSize(16).font(F_BOLD).fillColor(colors[i]?.fg || C.dark)
      .text(String(values[i] ?? '—'), x + 8, y + 20, { width: cardW - 16, align: 'left' });
  }
  doc.y = startY + cardH + 10;
}

function drawMsgSummarySection(doc, validation) {
  const sum = validation.summary || {};
  const src = sum.source || {};
  const cf  = sum.cfReport || {};
  const dst = sum.destination || {};
  const bs  = sum.bugSummary || {};
  const bugs = (validation.bugs || []).filter((b) => b.status === 'BUG');

  drawSectionHeader(doc, 'Migration Summary');

  const labels = ['Source Messages', 'Source Files', 'CF Picked', 'CF Processed', 'Dest Messages', 'Bugs Found'];
  const values = [
    src.totalMessages ?? '—',
    src.totalFiles ?? '—',
    cf.totalPicked ?? '—',
    cf.totalProcessed ?? '—',
    dst.totalMessages ?? (dst.channelsNotFound > 0 ? 'N/A' : '—'),
    bugs.length,
  ];
  const colors = [
    { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
    { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
    { bg: '#f5f3ff', fg: '#6d28d9', border: '#ddd6fe' },
    { bg: '#f5f3ff', fg: '#6d28d9', border: '#ddd6fe' },
    dst.channelsNotFound > 0
      ? { bg: '#fff7ed', fg: '#c2410c', border: '#fed7aa' }
      : { bg: '#f0fdf4', fg: '#16a34a', border: '#86efac' },
    bugs.length > 0
      ? { bg: '#fef2f2', fg: '#dc2626', border: '#fca5a5' }
      : { bg: '#f0fdf4', fg: '#16a34a', border: '#86efac' },
  ];
  drawMsgMetricCards(doc, labels, values, colors);

  // Bug severity mini-row
  doc.moveDown(0.3);
  const sevItems = [
    { label: 'CRITICAL', count: bs.byCritical ?? 0, ...severityColors('CRITICAL') },
    { label: 'HIGH',     count: bs.byHigh     ?? 0, ...severityColors('HIGH') },
    { label: 'MEDIUM',   count: bs.byMedium   ?? 0, ...severityColors('MEDIUM') },
    { label: 'LOW',      count: bs.byLow      ?? 0, ...severityColors('LOW') },
  ];
  const sevW = Math.floor((CONTENT_W - 3 * 6) / 4);
  const sy = doc.y;
  ensureSpace(doc, 36);
  for (let i = 0; i < 4; i++) {
    const x = MARGIN + i * (sevW + 6);
    const s = sevItems[i];
    doc.save().fillColor(s.bg).roundedRect(x, sy, sevW, 28, 4).fill().restore();
    doc.save().strokeColor(s.border).lineWidth(0.5).roundedRect(x, sy, sevW, 28, 4).stroke().restore();
    doc.fontSize(6.5).font(F_REGULAR).fillColor(s.fg)
      .text(s.label, x + 6, sy + 5, { width: sevW - 12 });
    doc.fontSize(13).font(F_BOLD).fillColor(s.fg)
      .text(String(s.count), x + 6, sy + 13, { width: sevW - 12 });
  }
  doc.y = sy + 36;

  // Processing rate note
  if (cf.processingRate) {
    doc.moveDown(0.3);
    doc.fontSize(8).font(F_REGULAR).fillColor(C.subtle)
      .text(`CF Processing Rate: ${cf.processingRate}  ·  Known Limitations: ${bs.knownLimitations ?? 0}`, MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.3);
  }
}

function drawMsgChannelTable(doc, validation) {
  const channels = validation.channels || [];
  if (channels.length === 0) return;

  drawSectionHeader(doc, 'Channel / DM Validation Summary');

  const COL = { name: 140, kind: 55, srcMsg: 60, srcFile: 55, cfPick: 60, dstMsg: 60, cfStatus: 80, result: 70 };
  const rowH = 18;
  const headerH = 22;

  ensureSpace(doc, headerH + rowH * Math.min(channels.length, 3) + 10);

  // Header
  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, headerH).fill().restore();
  const heads = [
    { label: 'Channel / DM', w: COL.name, align: 'left' },
    { label: 'Type', w: COL.kind, align: 'center' },
    { label: 'Src Msgs', w: COL.srcMsg, align: 'right' },
    { label: 'Src Files', w: COL.srcFile, align: 'right' },
    { label: 'CF Picked', w: COL.cfPick, align: 'right' },
    { label: 'Dst Msgs', w: COL.dstMsg, align: 'right' },
    { label: 'CF Status', w: COL.cfStatus, align: 'center' },
    { label: 'Result', w: COL.result, align: 'center' },
  ];
  let hx = MARGIN + 6;
  for (const h of heads) {
    doc.fontSize(7).font(F_BOLD).fillColor(C.subtle)
      .text(h.label, hx, y + 7, { width: h.w - 4, align: h.align });
    hx += h.w;
  }
  y += headerH;

  for (const ch of channels) {
    ensureSpace(doc, rowH + 2);
    const rowBg = ch.validationStatus === 'FAIL' ? '#fef2f2' :
                  ch.validationStatus === 'PARTIAL' ? '#fffbeb' : '#ffffff';
    doc.save().fillColor(rowBg).rect(MARGIN, y, CONTENT_W, rowH).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.5)
      .moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).stroke().restore();

    const cells = [
      { val: truncateRef(ch.channelName || ch.channelId, 22), w: COL.name, align: 'left', color: C.dark },
      { val: (ch.kind || 'ch').toUpperCase(), w: COL.kind, align: 'center', color: C.subtle },
      { val: ch.source?.messageCount ?? '—', w: COL.srcMsg, align: 'right', color: C.darkAlt },
      { val: ch.source?.fileCount ?? '—', w: COL.srcFile, align: 'right', color: C.darkAlt },
      { val: ch.cfReport?.totalMessages ?? '—', w: COL.cfPick, align: 'right', color: '#6d28d9' },
      { val: ch.destination?.found ? (ch.destination.messageCount ?? '—') : 'N/A', w: COL.dstMsg, align: 'right',
        color: ch.destination?.found ? C.darkAlt : C.muted },
      { val: String(ch.cfReport?.jobStatus || ch.jobStatus || '—').replace(/_/g, ' '), w: COL.cfStatus, align: 'center', color: C.subtle },
      { val: ch.validationStatus || '—', w: COL.result, align: 'center',
        color: ch.validationStatus === 'PASS' ? C.pass : ch.validationStatus === 'FAIL' ? C.fail : C.warn },
    ];
    let cx = MARGIN + 6;
    for (const cell of cells) {
      doc.fontSize(7.5).font(cell.bold ? F_BOLD : F_REGULAR).fillColor(cell.color || C.darkAlt)
        .text(String(cell.val), cx, y + 5, { width: cell.w - 6, align: cell.align });
      cx += cell.w;
    }
    y += rowH;
  }
  doc.y = y + 6;
}

function drawMsgBugDetails(doc, validation) {
  const bugs = (validation.bugs || []).filter((b) => b.status === 'BUG');
  if (bugs.length === 0) return;

  drawSectionHeader(doc, `Bug Details (${bugs.length})`);

  for (const bug of bugs) {
    ensureSpace(doc, 60);
    const { bg, fg, border } = severityColors(bug.severity);
    const cardY = doc.y;
    const cardH = 52;

    doc.save().fillColor(bg).roundedRect(MARGIN, cardY, CONTENT_W, cardH, 4).fill().restore();
    doc.save().strokeColor(border).lineWidth(0.75).roundedRect(MARGIN, cardY, CONTENT_W, cardH, 4).stroke().restore();

    // Severity + feature label
    doc.save().fillColor(fg).roundedRect(MARGIN + 8, cardY + 8, 48, 13, 3).fill().restore();
    doc.fontSize(6.5).font(F_BOLD).fillColor('#ffffff')
      .text(bug.severity, MARGIN + 8, cardY + 11, { width: 48, align: 'center' });

    doc.fontSize(8).font(F_BOLD).fillColor(C.dark)
      .text(bug.feature || bug.bugType || '', MARGIN + 62, cardY + 8, { width: CONTENT_W - 70, lineBreak: false });

    // Channel name
    doc.fontSize(7).font(F_REGULAR).fillColor(C.subtle)
      .text(`Channel: ${bug.channelName || bug.channel || '—'}`, MARGIN + 62, cardY + 20, { width: CONTENT_W - 70 });

    // Expected / Actual
    if (bug.expected != null || bug.actual != null) {
      const expStr = `Expected: ${bug.expected ?? '—'}   Actual: ${bug.actual ?? '—'}${bug.delta != null ? `   Delta: ${bug.delta > 0 ? '+' : ''}${bug.delta}` : ''}`;
      doc.fontSize(7).font(F_REGULAR).fillColor(fg)
        .text(expStr, MARGIN + 62, cardY + 31, { width: CONTENT_W - 70 });
    }

    // Description
    const descY = bug.expected != null ? cardY + 41 : cardY + 31;
    doc.fontSize(7).font(F_REGULAR).fillColor(C.darkAlt)
      .text(truncatePdfCell(bug.description, 180), MARGIN + 8, descY, { width: CONTENT_W - 16, lineBreak: false });

    doc.y = cardY + cardH + 6;
  }
}

function drawMsgKnownLimitations(doc, validation) {
  const allBugs = validation.bugs || [];
  const kl = allBugs.filter((b) => b.status === 'KNOWN_LIMITATION');
  if (kl.length === 0) return;

  // Deduplicate by feature
  const seen = new Map();
  for (const b of kl) {
    const key = b.feature || b.bugType;
    if (!seen.has(key)) seen.set(key, { feature: key, count: 0, channels: new Set() });
    const entry = seen.get(key);
    entry.channels.add(b.channel);
    if (typeof b.expected === 'number' && b.expected > 0) entry.count += b.expected;
  }
  const rows = [...seen.values()].map((e) => ({ ...e, channels: e.channels.size }));

  drawSectionHeader(doc, `Known Limitations (${rows.length})`);

  doc.fontSize(8).font(F_REGULAR).fillColor(C.subtle)
    .text('These features are outside CloudFuze\'s migration scope for Slack → Teams. They are expected and do not count as bugs.', MARGIN, doc.y, { width: CONTENT_W });
  doc.moveDown(0.5);

  const rowH = 18;
  const headerH = 20;
  const COL = { feature: CONTENT_W - 120, count: 60, channels: 60 };

  ensureSpace(doc, headerH + rowH * Math.min(rows.length, 5) + 10);
  let y = doc.y;

  // Header
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, headerH).fill().restore();
  doc.fontSize(7).font(F_BOLD).fillColor(C.subtle)
    .text('Feature / Limitation', MARGIN + 6, y + 6, { width: COL.feature - 6 });
  doc.text('Src Count', MARGIN + COL.feature, y + 6, { width: COL.count, align: 'right' });
  doc.text('Channels', MARGIN + COL.feature + COL.count, y + 6, { width: COL.channels - 6, align: 'right' });
  y += headerH;

  for (let i = 0; i < rows.length; i++) {
    ensureSpace(doc, rowH + 2);
    const rowBg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.save().fillColor(rowBg).rect(MARGIN, y, CONTENT_W, rowH).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.5)
      .moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).stroke().restore();

    // Yellow dot indicator
    doc.save().fillColor(C.warn).circle(MARGIN + 9, y + rowH / 2, 3).fill().restore();
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt)
      .text(rows[i].feature, MARGIN + 18, y + 5, { width: COL.feature - 18 });
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.subtle)
      .text(rows[i].count > 0 ? String(rows[i].count) : '—', MARGIN + COL.feature, y + 5, { width: COL.count, align: 'right' });
    doc.text(String(rows[i].channels), MARGIN + COL.feature + COL.count, y + 5, { width: COL.channels - 6, align: 'right' });
    y += rowH;
  }
  doc.y = y + 6;
}

function drawMsgSourceFeatureTable(doc, validation) {
  const channels = (validation.channels || []).filter((ch) => ch.source && ch.source.messageCount != null);
  if (channels.length === 0) return;

  drawSectionHeader(doc, 'Source Feature Inventory (Slack)');

  const FEATURES = [
    ['Messages', 'messageCount'], ['Files', 'fileCount'], ['Thread Replies', 'totalReplyCount'],
    ['Reactions', 'totalReactionCount'], ['Pinned', 'pinnedCount'],
    ['Bold Msgs', 'boldMsgCount'], ['Italic Msgs', 'italicMsgCount'],
    ['Strikethrough', 'strikethroughMsgCount'], ['Code Blocks', 'codeBlockMsgCount'],
    ['Ordered Lists', 'orderedListMsgCount'], ['Bullet Lists', 'bulletListMsgCount'],
    ['User Mentions', 'userMentionMsgCount'], ['Group Mentions', 'groupMentionMsgCount'],
    ['Links', 'linkMsgCount'], ['Emojis', 'emojiMsgCount'], ['Custom Emojis', 'customEmojiMsgCount'],
    ['GIFs', 'gifMsgCount'], ['Edited Msgs', 'editedMsgCount'],
    ['Forwarded', 'forwardedMsgCount'], ['Audio Files', 'audioFileCount'], ['Video Files', 'videoFileCount'],
  ];

  const rowH = 16;
  const colW = Math.floor(CONTENT_W / (channels.length + 1));
  const featColW = CONTENT_W - colW * channels.length;

  ensureSpace(doc, 24 + rowH * 5);
  let y = doc.y;

  // Header row
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, 20).fill().restore();
  doc.fontSize(7).font(F_BOLD).fillColor(C.subtle)
    .text('Feature', MARGIN + 4, y + 6, { width: featColW - 8 });
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const name = truncateRef(ch.channelName || ch.channelId, 14);
    doc.text(name, MARGIN + featColW + i * colW, y + 6, { width: colW, align: 'right' });
  }
  y += 20;

  for (let fi = 0; fi < FEATURES.length; fi++) {
    const [label, field] = FEATURES[fi];
    const vals = channels.map((ch) => ch.source?.[field] ?? 0);
    const anyNonZero = vals.some((v) => v > 0);
    if (!anyNonZero) continue;

    ensureSpace(doc, rowH + 2);
    const rowBg = fi % 2 === 0 ? '#ffffff' : '#f8fafc';
    doc.save().fillColor(rowBg).rect(MARGIN, y, CONTENT_W, rowH).fill().restore();
    doc.save().strokeColor(C.border).lineWidth(0.5)
      .moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).stroke().restore();

    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt)
      .text(label, MARGIN + 4, y + 4, { width: featColW - 8 });
    for (let i = 0; i < channels.length; i++) {
      const v = vals[i];
      doc.fontSize(7.5).font(v > 0 ? F_BOLD : F_REGULAR).fillColor(v > 0 ? C.dark : C.muted)
        .text(v > 0 ? String(v) : '—', MARGIN + featColW + i * colW, y + 4, { width: colW, align: 'right' });
    }
    y += rowH;
  }
  doc.y = y + 6;
}

// ── Main export ───────────────────────────────────────────────────────────────
// Render ONE execution's full report into an existing doc (no doc.end()). Shared by the
// single-execution and bulk (all-pairs-in-one) generators so each pair renders identically.
// opts.bulkStatusExecutions → draw the combined all-pairs CloudFuze Migration Status table here.
// opts.skipMigrationStatus  → don't draw this pair's own single-row status table.
function renderExecutionReport(doc, execution, opts = {}) {
  const result = execution.result;
  let validation = result?.validationSummary;
  if (!validation && result?.agentResults) {
    const agent = result.agentResults.find((a) => a.name === 'OutlookValidationAgent');
    validation = agent?.result || null;
  }
  const context = execution.context;

  // Detect message migration before transforming validation with the email-specific view builder
  const isMessage = validation?.productType === 'Message' || !!(context?.messageCombination);

  if (!isMessage && validation) validation = buildPdfValidationView(validation);

  // In bulk pair mode the shared cover page already rendered the combined header.
  if (!opts.bulkPairMode) {
    drawPageHeader(doc, execution, validation, context, result);
  }

  // Combined CloudFuze Migration Status (all pairs) — drawn even if this pair lacks validation.
  if (opts.bulkStatusExecutions) {
    drawBulkMigrationStatus(doc, opts.bulkStatusExecutions);
  }

  if (!validation) {
    doc.fontSize(10).font(F_REGULAR).fillColor(C.subtle)
      .text('No validation data is available for this execution.', MARGIN, doc.y, { width: CONTENT_W });
    drawFooter(doc, context);
    return;
  }

  // ── Message migration PDF ──
  if (isMessage) {
    drawMsgSummarySection(doc, validation);
    drawMsgChannelTable(doc, validation);
    drawMsgBugDetails(doc, validation);
    drawMsgKnownLimitations(doc, validation);
    drawMsgSourceFeatureTable(doc, validation);
    drawFooter(doc, context);
    return;
  }

  // ── Email / Calendar migration PDF (unchanged) ──
  if (!opts.skipMigrationStatus) {
    drawMigrationJobSection(doc, context, result);
  }
  drawSummarySection(doc, validation, context, result);
  drawFailureBreakdown(doc, validation);
  drawFunctionalityChecklist(doc, validation, context);
  drawEmailOrderSection(doc, validation);

  if (validation.sourceData && validation.destinationData) {
    drawDefaultFolderMapping(doc, validation);
    drawCustomFolderMapping(doc, validation);
  }

  // Mailbox Settings Validation section temporarily removed — to be re-added later.
  // (drawSettingsValidationSection is kept defined for when it returns.)
  drawNotFoundInDestination(doc, validation, context);
  drawAdvisoryWarnings(doc, validation);
  drawKeyIssues(doc, validation);
  drawFooter(doc, context);
}

function generateValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  registerUnicodeFonts(doc);
  doc.pipe(stream);
  renderExecutionReport(doc, execution);
  doc.end();
}

/**
 * Consolidated report for a bulk run: every user pair's validation in ONE PDF, each pair on its
 * own page (its own header + CloudFuze Migration Status with Job ID / Workspace ID + validation).
 * @param {object[]} executions  all pair executions of one bulk run (order preserved)
 */
function generateBulkValidationPdf(executions, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  registerUnicodeFonts(doc);
  doc.pipe(stream);

  const list = Array.isArray(executions) ? executions.filter(Boolean) : [];
  if (list.length === 0) {
    doc.fontSize(10).font(F_REGULAR).fillColor(C.subtle)
      .text('No executions found for this bulk run.', MARGIN, doc.y, { width: CONTENT_W });
    doc.end();
    return;
  }

  // Page 1: Shared cover — title, overall badge, pair overview grid, CF status, failure index.
  drawBulkCoverPage(doc, list);

  // Pages 2..N+1: Per-pair detail with a slim divider band instead of a repeated full header.
  list.forEach((execution, i) => {
    doc.addPage();
    const v      = getExValidation(execution);
    const status = v?.overallStatus || '—';
    drawPairDividerBand(doc, i + 1, list.length, execution, status);
    renderExecutionReport(doc, execution, { skipMigrationStatus: true, bulkPairMode: true });
  });

  doc.end();
}

// ── Content validation (Box → SharePoint etc.) ─────────────────────────────────
function drawContentSummaryCards(doc, checks) {
  const pass = checks.filter((c) => c.status === 'PASS').length;
  const warn = checks.filter((c) => c.status === 'WARN').length;
  const fail = checks.filter((c) => c.status === 'FAIL').length;

  const cards = [
    { value: pass, label: 'Passed',   vc: C.pass, bg: C.passBg, bd: C.passBorder },
    { value: warn, label: 'Warnings', vc: warn > 0 ? C.warn : C.subtle, bg: warn > 0 ? C.warnBg : C.bg, bd: warn > 0 ? C.warnBorder : C.border },
    { value: fail, label: 'Failed',   vc: fail > 0 ? C.fail : C.subtle, bg: fail > 0 ? C.failBg : C.bg, bd: fail > 0 ? C.failBorder : C.border },
  ];
  const gap = 10, cols = 3;
  const cardW = (CONTENT_W - gap * (cols - 1)) / cols;
  const cardH = 64;
  ensureSpace(doc, cardH + 16);
  const startY = doc.y;
  cards.forEach((m, i) => {
    const cx = MARGIN + i * (cardW + gap);
    doc.save().fillColor(m.bg).roundedRect(cx, startY, cardW, cardH, 6).fill().restore();
    doc.save().strokeColor(m.bd).lineWidth(1).roundedRect(cx, startY, cardW, cardH, 6).stroke().restore();
    doc.fontSize(22).font(F_BOLD).fillColor(m.vc).text(String(m.value), cx + 6, startY + 12, { width: cardW - 12, align: 'center' });
    doc.fontSize(8.5).font(F_BOLD).fillColor(C.text).text(m.label, cx + 6, startY + cardH - 22, { width: cardW - 12, align: 'center' });
  });
  doc.y = startY + cardH + 10;
}

function drawContentChecksTable(doc, checks) {
  const COL_CHECK = 170;
  const COL_STATUS = 60;
  const COL_DETAIL = CONTENT_W - COL_CHECK - COL_STATUS;
  const HDR_H = 20;

  ensureSpace(doc, HDR_H + 24);
  let y = doc.y;
  doc.save().fillColor('#f1f5f9').rect(MARGIN, y, CONTENT_W, HDR_H).fill().restore();
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  doc.text('Check',  MARGIN + 6, y + 6, { width: COL_CHECK - 10, lineBreak: false });
  doc.text('Status', MARGIN + COL_CHECK + 6, y + 6, { width: COL_STATUS - 10, lineBreak: false });
  doc.text('Detail', MARGIN + COL_CHECK + COL_STATUS + 6, y + 6, { width: COL_DETAIL - 10, lineBreak: false });
  doc.save().strokeColor('#94a3b8').lineWidth(0.5).moveTo(MARGIN, y + HDR_H).lineTo(MARGIN + CONTENT_W, y + HDR_H).stroke().restore();
  y += HDR_H;
  doc.y = y;

  checks.forEach((c, idx) => {
    const detail = String(c.detail || '');
    doc.fontSize(8).font(F_REGULAR);
    const checkH  = doc.heightOfString(String(c.name || ''), { width: COL_CHECK - 12 });
    const detailH = doc.heightOfString(detail, { width: COL_DETAIL - 12 });
    const rowH = Math.max(22, checkH + 10, detailH + 10);
    ensureSpace(doc, rowH + 2);
    y = doc.y;

    const tag = c.status === 'PASS' ? { bg: C.passBg, fg: C.pass } : c.status === 'WARN' ? { bg: C.warnBg, fg: C.warn } : { bg: C.failBg, fg: C.fail };
    if (c.status === 'FAIL') doc.save().fillColor(C.failBg).rect(MARGIN, y, CONTENT_W, rowH).fill().restore();
    else if (idx % 2 === 0) doc.save().fillColor('#fafafa').rect(MARGIN, y, CONTENT_W, rowH).fill().restore();

    doc.fontSize(8).font(F_BOLD).fillColor(C.text).text(String(c.name || ''), MARGIN + 6, y + 5, { width: COL_CHECK - 12 });
    const tagW = COL_STATUS - 12;
    doc.save().fillColor(tag.bg).roundedRect(MARGIN + COL_CHECK + 6, y + 5, tagW, 14, 3).fill().restore();
    doc.fontSize(7).font(F_BOLD).fillColor(tag.fg).text(c.status, MARGIN + COL_CHECK + 6, y + 8, { width: tagW, align: 'center', lineBreak: false });
    doc.fontSize(8).font(F_REGULAR).fillColor(C.darkAlt).text(detail, MARGIN + COL_CHECK + COL_STATUS + 6, y + 5, { width: COL_DETAIL - 12 });

    doc.save().strokeColor(C.border).lineWidth(0.3).moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).stroke().restore();
    doc.y = y + rowH;
  });
  doc.moveDown(0.5);
}

// Per-user banner: status pill + the migration mapping as a 4-column table
// (Source Email | Source Location | Dest Email | Dest Location).
function drawContentUserHeader(doc, idx, u) {
  const m = u.mapping || { sourceEmail: u.sourceEmail, sourceLocation: u.sourcePath, destEmail: u.destinationEmail, destLocation: u.destinationPath };
  const st = u.status === 'PASS' ? { bg: C.passBg, fg: C.pass } : u.status === 'FAIL' ? { bg: C.failBg, fg: C.fail } : { bg: C.warnBg, fg: C.warn };

  // Status line
  ensureSpace(doc, 18);
  let y = doc.y;
  const pillW = 70;
  doc.fontSize(9).font(F_BOLD).fillColor(C.text).text(`User ${idx}`, MARGIN, y + 2, { width: 120, lineBreak: false });
  doc.save().fillColor(st.bg).roundedRect(MARGIN + CONTENT_W - pillW, y, pillW, 15, 3).fill().restore();
  doc.fontSize(7.5).font(F_BOLD).fillColor(st.fg).text(`${u.status} · ${u.summary?.split(' ')[0] || ''}`, MARGIN + CONTENT_W - pillW, y + 4, { width: pillW, align: 'center', lineBreak: false });
  doc.y = y + 18;

  // Mapping table
  const cols = [
    { k: 'sourceEmail', label: 'Source Email', w: 0.24 },
    { k: 'sourceLocation', label: 'Source Location', w: 0.22 },
    { k: 'destEmail', label: 'Dest Email', w: 0.24 },
    { k: 'destLocation', label: 'Dest Location', w: 0.30 },
  ];
  const HDR_H = 16;
  ensureSpace(doc, HDR_H + 28);
  y = doc.y;
  doc.save().fillColor('#eef2ff').rect(MARGIN, y, CONTENT_W, HDR_H).fill().restore();
  let cx = MARGIN;
  doc.fontSize(7.5).font(F_BOLD).fillColor(C.darkAlt);
  for (const c of cols) { const w = CONTENT_W * c.w; doc.text(c.label, cx + 5, y + 4, { width: w - 8, lineBreak: false }); cx += w; }
  y += HDR_H;
  // value row height
  doc.fontSize(7.5).font(F_REGULAR);
  let rowH = 16;
  for (const c of cols) { const w = CONTENT_W * c.w; rowH = Math.max(rowH, doc.heightOfString(String(m[c.k] || '—'), { width: w - 8 }) + 6); }
  ensureSpace(doc, rowH + 8);
  cx = MARGIN;
  doc.save().strokeColor(C.border).lineWidth(0.4).rect(MARGIN, y, CONTENT_W, rowH).stroke().restore();
  for (const c of cols) {
    const w = CONTENT_W * c.w;
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.text).text(String(m[c.k] || '—'), cx + 5, y + 3, { width: w - 8 });
    cx += w;
  }
  doc.y = y + rowH + 8;
}

// Build an ASCII folder tree (├──/└──/│) from a list of relative folder paths.
function buildAsciiTree(rootName, relPaths) {
  const root = {};
  for (const p of relPaths || []) {
    let node = root;
    for (const seg of p.split('/').filter(Boolean)) { node[seg] = node[seg] || {}; node = node[seg]; }
  }
  const lines = [rootName];
  const walk = (node, prefix) => {
    const keys = Object.keys(node).sort((a, b) => a.localeCompare(b));
    keys.forEach((k, i) => {
      const last = i === keys.length - 1;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${k}`);
      walk(node[k], prefix + (last ? '    ' : '│   '));
    });
  };
  walk(root, '');
  return lines;
}

function drawTreeBlock(doc, title, lines) {
  ensureSpace(doc, 26);
  doc.fontSize(9).font(F_BOLD).fillColor(C.text).text(title, MARGIN, doc.y);
  doc.moveDown(0.15);
  doc.fontSize(7.5).font(F_MONO).fillColor(C.darkAlt);
  for (const ln of lines) {
    ensureSpace(doc, 9.5);
    doc.text(ln, MARGIN + 4, doc.y, { width: CONTENT_W - 8, lineBreak: false });
  }
  doc.moveDown(0.5);
}

// Folder-only structure validation: 6 metric cells + PASS/FAIL + the two ASCII trees + diffs.
function drawFolderStructureSection(doc, fs) {
  const cells = [
    ['Source Folders', fs.totalSource, false],
    ['Dest Folders', fs.totalDest, false],
    ['Matched', fs.matched, false],
    ['Missing', fs.missing.length, fs.missing.length > 0],
    ['Extra', fs.extra.length, fs.extra.length > 0],
    ['Misplaced', fs.misplaced.length, fs.misplaced.length > 0],
  ];
  const gap = 6, n = cells.length;
  const cw = (CONTENT_W - gap * (n - 1)) / n;
  const ch = 36;
  ensureSpace(doc, ch + 26);
  const y0 = doc.y;
  cells.forEach(([label, value, bad], i) => {
    const cx = MARGIN + i * (cw + gap);
    doc.save().fillColor(bad ? C.failBg : '#f8fafc').roundedRect(cx, y0, cw, ch, 4).fill().restore();
    doc.save().strokeColor(bad ? C.failBorder : C.border).lineWidth(0.5).roundedRect(cx, y0, cw, ch, 4).stroke().restore();
    doc.fontSize(14).font(F_BOLD).fillColor(bad ? C.fail : C.text).text(String(value), cx + 2, y0 + 5, { width: cw - 4, align: 'center' });
    doc.fontSize(6).font(F_REGULAR).fillColor(C.subtle).text(label, cx + 2, y0 + ch - 11, { width: cw - 4, align: 'center', lineBreak: false });
  });
  doc.y = y0 + ch + 8;

  ensureSpace(doc, 18);
  const st = fs.status === 'PASS' ? { bg: C.passBg, fg: C.pass } : { bg: C.failBg, fg: C.fail };
  const sy = doc.y;
  doc.save().fillColor(st.bg).roundedRect(MARGIN, sy, 150, 16, 3).fill().restore();
  doc.fontSize(8.5).font(F_BOLD).fillColor(st.fg).text(`Structure: ${fs.status}${fs.status === 'PASS' ? ' — identical' : ''}`, MARGIN, sy + 4, { width: 150, align: 'center', lineBreak: false });
  doc.y = sy + 22;

  // Field names differ per source cloud: Box→SharePoint emits box*/sp*, later combinations emit the
  // neutral source*/dest*. Accept both so one renderer serves every content combination.
  const srcRootName = fs.sourceRootName ?? fs.boxRootName;
  const dstRootName = fs.destRootName ?? fs.spRootName;
  const srcPaths = fs.sourceFolderPaths ?? fs.boxFolderPaths;
  const dstPaths = fs.destFolderPaths ?? fs.spFolderPaths;
  drawTreeBlock(doc, `${fs.sourceLabel || 'Box'} (Source)`, buildAsciiTree(srcRootName, srcPaths));
  drawTreeBlock(doc, `${fs.destLabel || 'SharePoint'} (Destination)`, buildAsciiTree(dstRootName, dstPaths));

  if (fs.status !== 'PASS') {
    const diffs = [];
    fs.missing.forEach((p) => diffs.push(['MISSING', p]));
    fs.extra.forEach((p) => diffs.push(['EXTRA', p]));
    fs.misplaced.forEach((m) => diffs.push(['MISPLACED', `${m.source}  →  ${m.dest}`]));
    if (diffs.length) {
      ensureSpace(doc, 16);
      doc.fontSize(8.5).font(F_BOLD).fillColor(C.text).text('Differences (full paths)', MARGIN, doc.y);
      doc.moveDown(0.2);
      for (const [k, p] of diffs) {
        ensureSpace(doc, 11);
        const yy = doc.y;
        doc.fontSize(7.5).font(F_BOLD).fillColor(C.fail).text(k, MARGIN + 4, yy, { width: 64, lineBreak: false });
        doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt).text(p, MARGIN + 72, yy, { width: CONTENT_W - 76 });
        doc.y = yy + Math.max(10, doc.heightOfString(p, { width: CONTENT_W - 76 }));
      }
      doc.moveDown(0.4);
    }
  }
}

// Full folder structure with per-item validation — indented tree of folders/files by name,
// each with a Found/Missing tag, its permission rows (Box role → mapped user → SP role), and
// version/timestamp notes.
function drawContentItemTree(doc, items, opts = {}) {
  const MAX = opts.max || 250;
  const shown = items.slice(0, MAX);
  for (const it of shown) {
    const indent = Math.min(it.depth || 0, 8) * 12;
    const x = MARGIN + indent;
    const tagW = 50;
    const availW = CONTENT_W - indent - tagW - 8;
    // destName is the neutral field; spName is the original Box→SharePoint name for it.
    const destName = it.destName ?? it.spName;
    const label = `${it.type === 'folder' ? '📁' : '📄'} ${it.name}${destName && destName !== it.name ? `  →  ${destName}` : ''}`;
    doc.fontSize(8).font(F_BOLD);
    const nameH = doc.heightOfString(label, { width: availW });
    const rowH = Math.max(14, nameH + 3);
    ensureSpace(doc, rowH + 2);
    const y = doc.y;
    // Three states, not two. An item over the SharePoint path limit is replaced by a Folder/File
    // Path Link URL at the destination (combination document #37) — printing it as "Missing" in red
    // reported documented platform behaviour as data loss, and contradicted check 11 on the same page.
    const tag = it.found
      ? { bg: C.passBg, fg: C.pass, txt: 'Found' }
      : it.placeholder
        ? { bg: C.warnBg, fg: C.warn, txt: 'Placeholder' }
        : { bg: C.failBg, fg: C.fail, txt: 'Missing' };
    const labelColor = it.found ? C.text : (it.placeholder ? C.warn : C.fail);
    doc.fontSize(8).font(F_BOLD).fillColor(labelColor).text(label, x, y + 1, { width: availW });
    doc.save().fillColor(tag.bg).roundedRect(MARGIN + CONTENT_W - tagW, y + 1, tagW, 12, 2).fill().restore();
    doc.fontSize(6.5).font(F_BOLD).fillColor(tag.fg).text(tag.txt, MARGIN + CONTENT_W - tagW, y + 3.5, { width: tagW, align: 'center', lineBreak: false });
    doc.y = y + rowH;

    for (const p of (it.permissions || [])) {
      const srcRole = p.sourceRole ?? p.boxRole;
      const dstRoles = p.destRoles ?? p.spRoles;
      const srcLabel = it.sourceLabel || (p.boxRole !== undefined ? 'Box' : 'Source');
      const via = p.viaGroup ? ' (via group)' : '';
      const who = p.principalType === 'group' ? `group ${p.user}` : p.user;
      const pStr = `↳ ${who}${p.mappedTo && p.mappedTo !== String(p.user).toLowerCase() ? ` → ${p.mappedTo}` : ''}: ${srcLabel} "${srcRole}" → SP ${dstRoles && dstRoles.length ? dstRoles.join('/') : 'no access'}${via} ${p.match ? '✓' : '✗'}`;
      const pw = CONTENT_W - indent - 14;
      ensureSpace(doc, 11);
      const py = doc.y;
      doc.fontSize(7).font(F_REGULAR).fillColor(p.match ? C.subtle : C.fail).text(pStr, x + 14, py, { width: pw });
      doc.y = py + Math.max(9, doc.heightOfString(pStr, { width: pw }));
    }
    const extras = [];
    if (it.versions) {
      const sv = it.versions.source ?? it.versions.box;
      const dv = it.versions.dest ?? it.versions.sp;
      // Counts are informational for Google sources — the API merges revisions — so no ✗ is shown
      // when the destination simply has fewer.
      const mark = it.versions.source !== undefined ? '' : (dv < sv ? ' ✗' : ' ✓');
      extras.push(`versions ${sv} → SP ${dv}${mark}`);
    }
    if (it.timestamps) extras.push(`modified ${it.timestamps.match ? 'preserved ✓' : 'changed ✗'}`);
    if (it.author) extras.push(`modifiedBy ${it.author.spModBy || '?'} ${it.author.match ? '✓' : '✗'}`);
    if (it.comments) extras.push(`${it.comments} comment(s) (Box)`);
    if (it.sharedLink) extras.push(`shared link ${it.sharedLink.onDest ? 'present ✓' : 'not on dest ✗'}`);
    for (const l of (it.sharedLinks || [])) {
      extras.push(`link ${l.sourceType}/${l.sourceRole} → ${l.actual} ${l.match ? '✓' : '✗'}`);
    }
    if (it.contentHash) extras.push(`content hash ${it.contentHash.ok ? 'identical ✓' : 'DIFFERS ✗'}`);
    if (extras.length) {
      // Advance by the MEASURED height, not a flat 9pt.
      //
      // This line carries every link on the item, so a folder deep in the tree produced six or more
      // wrapped lines while doc.y moved down only one — and the next item's name was then drawn on
      // top of the remainder. That is the overlapping text through the per-item pages of the report:
      // "Level 8" printed inside the previous item's trailing "anonymous/view, anonymous/view...".
      //
      // ensureSpace also has to reserve the real height, or a tall line starting near the page
      // bottom splits with its first line on one page and the rest on the next.
      const extrasText = `↳ ${extras.join('  ·  ')}`;
      const extrasW = CONTENT_W - indent - 14;
      doc.fontSize(6.8).font(F_REGULAR);
      const extrasH = doc.heightOfString(extrasText, { width: extrasW });
      ensureSpace(doc, extrasH + 3);
      const ey = doc.y;
      doc.fillColor(C.subtle).text(extrasText, x + 14, ey, { width: extrasW });
      doc.y = ey + Math.max(9, extrasH + 1);
    }
  }
  if (items.length > MAX) {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.subtle).text(`… ${items.length - MAX} more item(s) not shown`, MARGIN, doc.y + 2);
    doc.moveDown(0.5);
  }
}

/**
 * Per-feature checklist for a content combination: one row per documented feature, with its state.
 * "Not assessed" rows are printed too, with the reason — a feature the run could not exercise must
 * be visible as such rather than quietly missing from the report.
 */
function drawContentFeatureChecklist(doc, checklist, summary) {
  drawSectionHeader(doc, 'Feature Checklist — documented features for this combination');

  if (summary?.line) {
    ensureSpace(doc, 14);
    doc.fontSize(8.5).font(F_BOLD).fillColor(C.text)
      .text(summary.line, MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.4);
  }

  const STATE = {
    pass: { bg: C.passBg, fg: C.pass, txt: 'PASS' },
    fail: { bg: C.failBg, fg: C.fail, txt: 'FAIL' },
    na: { bg: C.subtleBg || C.passBg, fg: C.subtle, txt: 'N/A' },
    info: { bg: C.passBg, fg: C.subtle, txt: 'INFO' },
  };

  let category = null;
  for (const row of checklist) {
    if (row.category !== category) {
      category = row.category;
      ensureSpace(doc, 14);
      doc.fontSize(8).font(F_BOLD).fillColor(C.subtle)
        .text(category, MARGIN, doc.y, { width: CONTENT_W });
      doc.moveDown(0.15);
    }
    const st = STATE[row.status] || STATE.na;
    // Measure the row BEFORE reserving space. A flat 20pt was reserved while the title and detail
    // below wrap freely, so a long detail starting near the page bottom drew its status tag on one
    // page and its text on the next — the overlap seen in the report.
    const tagW = 30;
    const textW0 = CONTENT_W - tagW - 6;
    const titleH = doc.fontSize(8).font(F_BOLD)
      .heightOfString(`${row.id}  ${row.feature}`, { width: textW0 });
    const detailH = row.detail
      ? doc.fontSize(7).font(F_REGULAR).heightOfString(String(row.detail), { width: textW0 })
      : 0;
    ensureSpace(doc, titleH + detailH + 8);
    const y = doc.y;
    doc.save().fillColor(st.bg).roundedRect(MARGIN, y + 1, tagW, 11, 2).fill().restore();
    doc.fontSize(6.5).font(F_BOLD).fillColor(st.fg)
      .text(st.txt, MARGIN, y + 3.5, { width: tagW, align: 'center', lineBreak: false });

    const textX = MARGIN + tagW + 6;
    const textW = textW0;
    doc.fontSize(8).font(F_BOLD).fillColor(C.text)
      .text(`${row.id}  ${row.feature}`, textX, y, { width: textW });
    if (row.detail) {
      doc.fontSize(7).font(F_REGULAR).fillColor(C.subtle)
        .text(row.detail, textX, doc.y, { width: textW });
    }
    doc.moveDown(0.25);
  }
  doc.moveDown(0.4);
}

/**
 * Collapse one check's detail string into distinct reasons with counts.
 *
 * Content checks report every affected item on one line, joined by " | ", each shaped roughly as
 * "<path> — <reason>". A permissions failure therefore arrives as 77 segments that name the SAME
 * underlying cause 77 times. Grouping on the reason turns that into one row saying "x77", which is
 * the difference between a report a reviewer can act on and one they scroll past.
 */
function groupFailureReasons(detail) {
  const segments = String(detail || '').split(' | ').map((x) => x.trim()).filter(Boolean);
  const counts = new Map();
  for (const seg of segments) {
    // The reason is the text after the last em dash; without one the whole segment is the reason.
    const cut = seg.lastIndexOf('—');
    const reason = (cut >= 0 ? seg.slice(cut + 1) : seg).trim() || seg.trim();
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Failure Index for content runs — the mail report opens with one and the content report did not,
 * so a reviewer had to read every table to find out what was actually wrong. Lists each failing
 * check once, with its distinct root causes and how many items each affects.
 */
function drawContentFailureIndex(doc, checks, perUser) {
  const failing = [];
  const collect = (list, who) => {
    for (const c of (list || [])) {
      if (String(c.status).toUpperCase() !== 'FAIL') continue;
      failing.push({ who, name: String(c.name || c.check || ''), reasons: groupFailureReasons(c.detail) });
    }
  };
  collect(checks, null);
  for (const u of (perUser || [])) collect(u.checks, u.sourceEmail || '');
  if (failing.length === 0) return;

  drawSectionHeader(doc, `Failure Index — ${failing.length} failing check(s), most affected first`);

  const NAME_W = 175;
  const CNT_W = 42;
  const REASON_W = CONTENT_W - NAME_W - CNT_W;
  const totalOf = (f) => f.reasons.reduce((n, r) => n + r.count, 0);
  failing.sort((a, b) => totalOf(b) - totalOf(a));

  // Header row
  ensureSpace(doc, 30);
  let y = doc.y;
  doc.save().fillColor('#F1F5F9').rect(MARGIN, y, CONTENT_W, 18).fill().restore();
  doc.fontSize(8).font(F_BOLD).fillColor(C.darkAlt);
  doc.text('Check', MARGIN + 6, y + 5, { width: NAME_W - 10, lineBreak: false });
  doc.text('Items', MARGIN + NAME_W, y + 5, { width: CNT_W - 6, align: 'right', lineBreak: false });
  doc.text('Root cause', MARGIN + NAME_W + CNT_W + 6, y + 5, { width: REASON_W - 10, lineBreak: false });
  y += 18;
  doc.save().strokeColor(C.border).lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).stroke().restore();
  doc.y = y;

  for (const f of failing) {
    // At most three distinct causes per check keeps the index to one screen; the per-check tables
    // below still carry every line.
    const shown = f.reasons.slice(0, 3);
    const hidden = f.reasons.length - shown.length;
    const label = (f.who && !f.name.startsWith('[')) ? `[${f.who}] ${f.name}` : f.name;

    for (let i = 0; i < shown.length; i++) {
      const r = shown[i];
      const reasonText = r.reason.length > 300 ? `${r.reason.slice(0, 300)}…` : r.reason;
      const h = Math.max(
        doc.fontSize(7.5).font(F_REGULAR).heightOfString(reasonText, { width: REASON_W - 10 }),
        doc.fontSize(8).font(F_BOLD).heightOfString(label, { width: NAME_W - 10 })
      ) + 8;
      ensureSpace(doc, h + 2);
      const rowY = doc.y;
      if (i === 0) {
        doc.save().fillColor(C.failBg).rect(MARGIN, rowY, 3, h).fill().restore();
        doc.fontSize(8).font(F_BOLD).fillColor(C.text)
          .text(label, MARGIN + 6, rowY + 4, { width: NAME_W - 10 });
      }
      doc.fontSize(8).font(F_BOLD).fillColor(r.count > 1 ? C.fail : C.subtle)
        .text(r.count > 1 ? `x${r.count}` : '1', MARGIN + NAME_W, rowY + 4,
          { width: CNT_W - 6, align: 'right', lineBreak: false });
      doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt)
        .text(reasonText, MARGIN + NAME_W + CNT_W + 6, rowY + 4, { width: REASON_W - 10 });
      doc.y = rowY + h;
    }
    if (hidden > 0) {
      ensureSpace(doc, 14);
      doc.fontSize(7).font(F_REGULAR).fillColor(C.muted)
        .text(`+ ${hidden} further distinct cause(s) — see the per-check table below`,
          MARGIN + NAME_W + CNT_W + 6, doc.y + 1, { width: REASON_W - 10 });
      doc.y += 12;
    }
    doc.save().strokeColor(C.border).lineWidth(0.4)
      .moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y).stroke().restore();
    doc.y += 4;
  }
  doc.moveDown(0.6);
}
function generateContentValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  registerUnicodeFonts(doc);
  doc.pipe(stream);

  const result  = execution.result || {};
  const v       = result.validationSummary || {};
  const checks  = Array.isArray(v.checks) ? v.checks : [];
  const perUser = Array.isArray(v.perUser) ? v.perUser : [];
  const context = execution.context || {};
  // Global (non-user) checks: site access, CloudFuze status, skipped pairs.
  const globalChecks = checks.filter((c) => !/^\[/.test(String(c.name || '')));

  drawPageHeader(doc, execution, { overallStatus: v.status || 'N/A' }, context, result);
  drawMigrationJobSection(doc, context, result);

  drawSectionHeader(doc, '1 — Validation Summary');
  if (checks.length === 0) {
    doc.fontSize(9).font(F_REGULAR).fillColor(C.subtle)
      .text('No content validation checks are available for this execution.', MARGIN, doc.y, { width: CONTENT_W });
    doc.moveDown(0.6);
    drawFooter(doc, context);
    doc.end();
    return;
  }

  drawContentSummaryCards(doc, checks);

  // What actually failed, and why — before any of the detail tables.
  drawContentFailureIndex(doc, globalChecks, perUser);

  if (perUser.length > 0) {
    // Migration / site-level checks first, then one section per migrated user.
    if (globalChecks.length > 0) {
      drawSectionHeader(doc, '2 — Migration & Site Checks');
      drawContentChecksTable(doc, globalChecks);
    }
    perUser.forEach((u, i) => {
      drawSectionHeader(doc, `${globalChecks.length > 0 ? i + 3 : i + 2} — User ${i + 1}: ${u.sourceEmail || ''}`);
      drawContentUserHeader(doc, i + 1, u);
      drawContentChecksTable(doc, u.checks || []);
      if (u.folderStructure) {
        drawSectionHeader(doc, `Folder structure validation — ${u.folderStructure.status}`);
        drawFolderStructureSection(doc, u.folderStructure);
      }
      if ((u.items || []).length > 0) {
        drawSectionHeader(doc, `Per-item validation (${u.items.length} items — files, permissions, versions)`);
        drawContentItemTree(doc, u.items);
      }
    });
  } else {
    // Legacy single-folder report (no per-user breakdown).
    drawSectionHeader(doc, '2 — Validation Checks (location, name, permissions, versions, timestamps, metadata, comments, shared links)');
    drawContentChecksTable(doc, checks);
  }

  // Per-feature rollup against the combination's documented feature list, when the validator
  // produced one. This is the section that answers "which documented features actually work".
  if (Array.isArray(v.featureChecklist) && v.featureChecklist.length > 0) {
    drawContentFeatureChecklist(doc, v.featureChecklist, v.featureSummary);
  }

  drawFooter(doc, context);
  doc.end();
}

module.exports = { generateValidationPdf, generateContentValidationPdf, generateBulkValidationPdf };
