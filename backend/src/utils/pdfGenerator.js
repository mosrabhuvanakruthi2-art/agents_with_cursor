'use strict';

const PDFDocument = require('pdfkit');
const fs = require('fs');
const ValidationResult = require('../models/ValidationResult');
const { findDestCustomFolder, buildPdfValidationView } = require('./gmailOutlookLabelMatch');

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

  const metaItems = [
    `${src} → ${dest}`,
    `Type: ${context?.testType || 'E2E'}`,
    `Migration: ${context?.migrationType === 'DELTA' ? 'DELTA' : 'FULL'}`,
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
    doc.text(item, MARGIN + i * metaColW, 100, { width: metaColW - 6, lineBreak: false });
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
  const jobIdFull = String(migJob0?.jobId || migJob0?.jobName || '—');
  if (jobIdFull && jobIdFull !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job ID: ${jobIdFull}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
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
  COLS.forEach((c) => { doc.text(c.label, hx + 5, y + 6, { width: c.w - 10, lineBreak: false }); hx += c.w; });
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
          .text(cell.text, rx + 5, y + 8, { width: cell.w - 10, lineBreak: false });
      } else {
        const tagW = cell.w - 10;
        doc.save().fillColor(badge.bg).roundedRect(rx + 5, y + 6, tagW, 15, 3).fill().restore();
        doc.fontSize(7).font(F_BOLD).fillColor(badge.fg)
          .text(badge.label, rx + 5, y + 10, { width: tagW, align: 'center', lineBreak: false });
      }
      rx += cell.w;
    });
    y += ROW_H;
  });
  doc.save().strokeColor('#e2e8f0').lineWidth(0.5)
    .moveTo(MARGIN, y).lineTo(MARGIN + TABLE_W, y).stroke().restore();
  doc.y = y + 8;
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

  // Full Job ID / Name strip — the table column truncates long job names, so show it in full here.
  const jobIdFull = String(migJob?.jobId || migJob?.jobName || '—');
  if (jobIdFull && jobIdFull !== '—') {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.muted)
      .text(`Job ID: ${jobIdFull}`, MARGIN, doc.y, { width: CONTENT_W, lineBreak: false });
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
    doc.text(c.label, hx + 5, y + 6, { width: c.w - 10, lineBreak: false });
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
        .text(cell.text, rx + 5, y + 9, { width: cell.w - 10, lineBreak: false });
    } else {
      // Status badge — full width of remaining column
      const tagW = cell.w - 10;
      doc.save().fillColor(statusBg).roundedRect(rx + 5, y + 7, tagW, 16, 3).fill().restore();
      doc.fontSize(7.5).font(F_BOLD).fillColor(statusFg)
        .text(cfStatusLabel, rx + 5, y + 11, { width: tagW, align: 'center', lineBreak: false });
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

  doc.moveDown(0.6);
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
  const dstMail = dstDefaults.filter((f) => MAPPED_OUTLOOK.has(String(f.name ?? '')))
                    .reduce((s, f) => s + (f.messageCount || 0), 0)
                + dstCustoms.reduce((s, f) => s + (f.messageCount || 0), 0);
  const mailMatch = srcMail === dstMail;

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
      value: `${srcMail} → ${dstMail}`,
      label: 'Mailbox Email Count',
      sub:   'Total emails: source → destination',
      vc: mailMatch ? C.pass : C.fail,
      bg: mailMatch ? C.passBg : C.failBg,
      bd: mailMatch ? C.passBorder : C.failBorder,
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

    const isNested = supportNested && row.nested;
    const label    = isNested
      ? `↳ ${(row.label || '').split('/').pop()}`
      : (row.label || '—');
    const indent = isNested ? 10 : 0;

    let rx = MARGIN;
    doc.fontSize(8.5).font(F_REGULAR).fillColor(C.text)
      .text(label, rx + 6 + indent, y + 6, { width: COL_W[0] - 12 - indent, lineBreak: false });
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
  drawSectionHeader(doc, '3 — Default Folder Mapping');
  const rows = buildComparisonRows(
    validation.sourceData.defaultLabels  || [],
    validation.destinationData.defaultFolders || [],
    { INBOX: 'Inbox', SENT: 'Sent Items', DRAFT: 'Drafts', TRASH: 'Deleted Items', SPAM: 'Junk Email' }
  );
  drawFolderTable(doc, rows, false);
}

// ── Section 4: Custom folder mapping ─────────────────────────────────────────
function drawCustomFolderMapping(doc, validation) {
  drawSectionHeader(doc, '4 — Custom Folder Mapping');

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
      'Note: Custom folder counts are compared after label mapping. Nested folders (/) are shown with ↳ prefix.',
      MARGIN + 8, ibY + 8, { width: CONTENT_W - 16 }
    );
  doc.y = ibY + 32;
}

// ── Section 5: Advisory warnings ─────────────────────────────────────────────
// ── Section 5: Settings & Rules Validation (Outlook→Outlook only) ─────────────
function drawSettingsValidationSection(doc, validation) {
  const sv = validation?.settingsValidation;
  if (!sv || !sv.available) return;

  drawSectionHeader(doc, '5 — Mailbox Settings Validation');

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

function drawAdvisoryWarnings(doc, validation) {
  const { results } = normalizeDeepMailResultsForPdf(validation);
  const warned = results.filter((r) => r.pass && (r.diffs || []).some((d) => d.ok === false));
  if (warned.length === 0) return;

  drawSectionHeader(doc, `6 — Advisory Warnings (${warned.length})`);
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
  const failed = results.filter((r) => !r.pass);

  const bugCount   = failed.filter((r) => r.bugStatus !== 'known_limitation').length;
  const limitCount = failed.filter((r) => r.bugStatus === 'known_limitation').length;
  const issueLabel = failed.length === 0
    ? '7 — Key Issues'
    : limitCount > 0
      ? `7 — Key Issues (${bugCount} bug${bugCount !== 1 ? 's' : ''}, ${limitCount} known limitation${limitCount !== 1 ? 's' : ''})`
      : `7 — Key Issues (${bugCount} failed)`;
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
  if (validation) validation = buildPdfValidationView(validation);
  const context = execution.context;

  drawPageHeader(doc, execution, validation, context, result);

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

  if (!opts.skipMigrationStatus) {
    drawMigrationJobSection(doc, context, result);
  }
  drawSummarySection(doc, validation, context, result);
  drawFailureBreakdown(doc, validation);

  if (validation.sourceData && validation.destinationData) {
    drawDefaultFolderMapping(doc, validation);
    drawCustomFolderMapping(doc, validation);
  }

  drawSettingsValidationSection(doc, validation);
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

  list.forEach((execution, i) => {
    if (i > 0) doc.addPage();
    // Combined CloudFuze Migration Status (every pair, one row each) shows once on the first page;
    // each pair's own single-row status table is suppressed to avoid repetition.
    renderExecutionReport(doc, execution, {
      bulkStatusExecutions: i === 0 ? list : null,
      skipMigrationStatus: true,
    });
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

  drawTreeBlock(doc, 'Box (Source)', buildAsciiTree(fs.boxRootName, fs.boxFolderPaths));
  drawTreeBlock(doc, 'SharePoint (Destination)', buildAsciiTree(fs.spRootName, fs.spFolderPaths));

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
    const label = `${it.type === 'folder' ? '📁' : '📄'} ${it.name}${it.spName && it.spName !== it.name ? `  →  ${it.spName}` : ''}`;
    doc.fontSize(8).font(F_BOLD);
    const nameH = doc.heightOfString(label, { width: availW });
    const rowH = Math.max(14, nameH + 3);
    ensureSpace(doc, rowH + 2);
    const y = doc.y;
    const tag = it.found ? { bg: C.passBg, fg: C.pass, txt: 'Found' } : { bg: C.failBg, fg: C.fail, txt: 'Missing' };
    doc.fontSize(8).font(F_BOLD).fillColor(it.found ? C.text : C.fail).text(label, x, y + 1, { width: availW });
    doc.save().fillColor(tag.bg).roundedRect(MARGIN + CONTENT_W - tagW, y + 1, tagW, 12, 2).fill().restore();
    doc.fontSize(6.5).font(F_BOLD).fillColor(tag.fg).text(tag.txt, MARGIN + CONTENT_W - tagW, y + 3.5, { width: tagW, align: 'center', lineBreak: false });
    doc.y = y + rowH;

    for (const p of (it.permissions || [])) {
      const pStr = `↳ ${p.user}${p.mappedTo && p.mappedTo !== String(p.user).toLowerCase() ? ` → ${p.mappedTo}` : ''}: Box "${p.boxRole}" → SP ${p.spRoles && p.spRoles.length ? p.spRoles.join('/') : 'no access'} ${p.match ? '✓' : '✗'}`;
      const pw = CONTENT_W - indent - 14;
      ensureSpace(doc, 11);
      const py = doc.y;
      doc.fontSize(7).font(F_REGULAR).fillColor(p.match ? C.subtle : C.fail).text(pStr, x + 14, py, { width: pw });
      doc.y = py + Math.max(9, doc.heightOfString(pStr, { width: pw }));
    }
    const extras = [];
    if (it.versions) extras.push(`versions Box ${it.versions.box} → SP ${it.versions.sp}${it.versions.sp < it.versions.box ? ' ✗' : ' ✓'}`);
    if (it.timestamps) extras.push(`modified ${it.timestamps.match ? 'preserved ✓' : 'changed ✗'}`);
    if (it.author) extras.push(`modifiedBy ${it.author.spModBy || '?'} ${it.author.match ? '✓' : '✗'}`);
    if (it.comments) extras.push(`${it.comments} comment(s) (Box)`);
    if (it.sharedLink) extras.push(`shared link ${it.sharedLink.onDest ? 'present ✓' : 'not on dest ✗'}`);
    if (extras.length) {
      ensureSpace(doc, 10);
      const ey = doc.y;
      doc.fontSize(6.8).font(F_REGULAR).fillColor(C.subtle).text(`↳ ${extras.join('  ·  ')}`, x + 14, ey, { width: CONTENT_W - indent - 14 });
      doc.y = ey + 9;
    }
  }
  if (items.length > MAX) {
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.subtle).text(`… ${items.length - MAX} more item(s) not shown`, MARGIN, doc.y + 2);
    doc.moveDown(0.5);
  }
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

  drawFooter(doc, context);
  doc.end();
}

module.exports = { generateValidationPdf, generateContentValidationPdf, generateBulkValidationPdf };
