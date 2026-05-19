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
};

function firstExistingPath(paths) {
  for (const p of paths) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return null;
}

let F_REGULAR = 'Helvetica';
let F_BOLD    = 'Helvetica-Bold';
let F_ITALIC  = 'Helvetica-Oblique';

function registerUnicodeFonts(doc) {
  const reg  = firstExistingPath(FONT_CANDIDATES.regular);
  const bold = firstExistingPath(FONT_CANDIDATES.bold);
  const ital = firstExistingPath(FONT_CANDIDATES.italic);
  if (reg)  { try { doc.registerFont('Unicode',       reg);  F_REGULAR = 'Unicode';       } catch { F_REGULAR = 'Helvetica';         } }
  if (bold) { try { doc.registerFont('UnicodeBold',   bold); F_BOLD    = 'UnicodeBold';   } catch { F_BOLD    = 'Helvetica-Bold';    } }
  if (ital) { try { doc.registerFont('UnicodeItalic', ital); F_ITALIC  = 'UnicodeItalic'; } catch { F_ITALIC  = 'Helvetica-Oblique'; } }
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
  const metaItems = [
    `Exec: ${String(execution.executionId || '—').slice(0, 20)}`,
    `${src} → ${dest}`,
    `Type: ${context?.testType || 'E2E'}`,
    `Migration: ${context?.migrationType === 'DELTA' ? 'DELTA' : 'FULL'}`,
    `Duration: ${result?.duration != null ? formatDurationMs(result.duration) : 'N/A'}`,
  ];
  const metaColW = CONTENT_W / metaItems.length;
  doc.fontSize(7.5).font(F_REGULAR).fillColor(C.darkAlt);
  metaItems.forEach((item, i) => {
    doc.text(item, MARGIN + i * metaColW, 96, { width: metaColW - 6, lineBreak: false });
  });

  doc.y = 140;
}

// ── CloudFuze Migration Status (before Section 1) ────────────────────────────
function drawMigrationJobSection(doc, context) {
  const migJob    = context?.migrationJobDetails;
  const srcEmail  = context?.sourceEmail      || '—';
  const dstEmail  = context?.destinationEmail || '—';
  const hasData   = migJob || srcEmail !== '—' || dstEmail !== '—';
  if (!hasData) return;

  drawSectionHeader(doc, 'CloudFuze Migration Status');

  // ── header row ─────────────────────────────────────────────────────────────
  const COLS = [
    { label: 'Workspace ID', w: 100 },
    { label: 'From Email',   w: 134 },
    { label: 'To Email',     w: 134 },
    { label: 'Total',        w:  54 },
    { label: 'Processed',    w:  64 },
    { label: 'Status',       w:  CONTENT_W - 100 - 134 - 134 - 54 - 64 },
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
  const workspaceId    = String(migJob?.workspaceId || context?.jobId || '—');
  const totalCount     = migJob?.totalCount     != null ? String(migJob.totalCount)     : '—';
  const processedCount = migJob?.processedCount != null ? String(migJob.processedCount) : '—';
  const cfStatusRaw    = String(migJob?.cfStatus || '—');
  const cfStatusLabel  = cfStatusRaw.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
  const cfStatusUp     = cfStatusRaw.toUpperCase();

  let statusBg = '#f1f5f9', statusFg = C.subtle;
  if (/^PROCESS(ED)?$/.test(cfStatusUp) || cfStatusUp === 'PROCESSED_WITH_CONFLICTS' || cfStatusUp === 'PROCESS_WITH_CONFLICTS') {
    statusBg = C.passBg; statusFg = C.pass;
  } else if (/FAIL|ERROR|CONFLICT/.test(cfStatusUp)) {
    statusBg = C.failBg; statusFg = C.fail;
  } else if (/PROGRESS|INPROG|QUEUE|INIT|RUN|PROCESS/.test(cfStatusUp)) {
    statusBg = C.warnBg; statusFg = C.warn;
  }

  doc.save().fillColor('#fafafa').rect(MARGIN, y, TABLE_W, ROW_H).fill().restore();

  const cells = [
    { text: workspaceId,    w: COLS[0].w },
    { text: srcEmail,       w: COLS[1].w },
    { text: dstEmail,       w: COLS[2].w },
    { text: totalCount,     w: COLS[3].w },
    { text: processedCount, w: COLS[4].w },
    { text: null,           w: COLS[5].w },   // status badge handled separately
  ];

  let rx = MARGIN;
  cells.forEach((cell, i) => {
    if (i < cells.length - 1) {
      doc.fontSize(8).font(F_REGULAR).fillColor(C.text)
        .text(cell.text, rx + 5, y + 9, { width: cell.w - 10, lineBreak: false });
    } else {
      // Status badge in last cell
      const tagW = Math.min(cell.w - 10, 110);
      doc.save().fillColor(statusBg).roundedRect(rx + 5, y + 8, tagW, 14, 3).fill().restore();
      doc.fontSize(7.5).font(F_BOLD).fillColor(statusFg)
        .text(cfStatusLabel, rx + 5, y + 10, { width: tagW, align: 'center', lineBreak: false });
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
  const deepFailed    = deepResults.filter((r) => !r.pass).length;
  const totalFindings = (validation.mismatches || []).length;

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

  const metrics = [
    { value: deep.scannedSourceMessages ?? '—', label: 'Messages Scanned', vc: C.text,  bg: C.bg,      bd: C.border      },
    { value: deep.pairedCount           ?? '—', label: 'Paired Messages',  vc: C.text,  bg: C.bg,      bd: C.border      },
    { value: deepFailed,    label: 'Deep Mail Failures', vc: deepFailed > 0 ? C.fail : C.pass, bg: deepFailed > 0 ? C.failBg : C.passBg, bd: deepFailed > 0 ? C.failBorder : C.passBorder },
    { value: totalFindings, label: 'Total Findings',    vc: totalFindings > 0 ? C.warn : C.pass, bg: totalFindings > 0 ? C.warnBg : C.passBg, bd: totalFindings > 0 ? C.warnBorder : C.passBorder },
    { value: result?.duration != null ? formatDurationMs(result.duration) : '—', label: 'Duration', vc: C.text, bg: C.bg, bd: C.border },
    { value: `${srcMail} / ${dstMail}`, label: 'Mail Count (Src / Dst)', vc: mailMatch ? C.pass : C.fail, bg: mailMatch ? C.passBg : C.failBg, bd: mailMatch ? C.passBorder : C.failBorder },
  ];

  const gap = 10;
  const cols = 3;
  const cardW = (CONTENT_W - gap * (cols - 1)) / cols;
  const cardH = 70;

  ensureSpace(doc, cardH * 2 + gap + 16);
  let startY = doc.y;

  metrics.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx  = MARGIN + col * (cardW + gap);
    const cy  = startY + row * (cardH + gap);

    doc.save().fillColor(m.bg).roundedRect(cx, cy, cardW, cardH, 6).fill().restore();
    doc.save().strokeColor(m.bd).lineWidth(1).roundedRect(cx, cy, cardW, cardH, 6).stroke().restore();

    const valStr  = String(m.value ?? '—');
    const valSize = valStr.length > 8 ? 13 : valStr.length > 5 ? 16 : 20;
    doc.fontSize(valSize).font(F_BOLD).fillColor(m.vc)
      .text(valStr, cx + 6, cy + 14, { width: cardW - 12, align: 'center' });
    doc.fontSize(7.5).font(F_REGULAR).fillColor(C.subtle)
      .text(m.label, cx + 6, cy + cardH - 20, { width: cardW - 12, align: 'center' });
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

  // ── Mailbox checks (section emails) ────────────────────────────────────────
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

  drawSectionHeader(doc, failed.length === 0 ? '7 — Key Issues' : `7 — Key Issues (${failed.length} failed)`);

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
    const severity  = reason.severity || 'warning';
    const accentCol = severity === 'critical' ? C.fail : severity === 'warning' ? C.warn : C.muted;
    const tagBg     = severity === 'critical' ? C.failBg : severity === 'warning' ? C.warnBg : '#f1f5f9';
    const tagFg     = severity === 'critical' ? C.fail   : severity === 'warning' ? C.warn   : C.subtle;
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
    const tagLabel = severity.toUpperCase();
    const tagW     = 54;
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
function generateValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  registerUnicodeFonts(doc);
  doc.pipe(stream);

  const result = execution.result;
  let validation = result?.validationSummary;
  if (!validation && result?.agentResults) {
    const agent = result.agentResults.find((a) => a.name === 'OutlookValidationAgent');
    validation = agent?.result || null;
  }
  if (validation) validation = buildPdfValidationView(validation);
  const context = execution.context;

  drawPageHeader(doc, execution, validation, context, result);

  if (!validation) {
    doc.fontSize(10).font(F_REGULAR).fillColor(C.subtle)
      .text('No validation data is available for this execution.', MARGIN, doc.y, { width: CONTENT_W });
    drawFooter(doc, context);
    doc.end();
    return;
  }

  drawMigrationJobSection(doc, context);
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

  doc.end();
}

module.exports = { generateValidationPdf };