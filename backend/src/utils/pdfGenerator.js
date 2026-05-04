const PDFDocument = require('pdfkit');
const { findDestCustomFolder, buildPdfValidationView } = require('./gmailOutlookLabelMatch');

const MARGIN = 50;
const PAGE_WIDTH = 595;
const CONTENT_W = PAGE_WIDTH - MARGIN * 2;

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
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e293b').text(title, left, doc.y, {
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
    doc.font('Helvetica-Bold').fillColor('#475569').text(`${label}:`, left, y, { width: labelW });
    doc.font('Helvetica').fillColor('#0f172a').text(v, left + labelW, y, { width: valueW, lineGap: 1 });
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
  const labelW = 130;
  const valueW = CONTENT_W - labelW;
  let y = doc.y;
  doc.fontSize(10);
  for (const [label, value] of pairs) {
    const v = String(value ?? 'N/A');
    const valueH = doc.heightOfString(v, { width: valueW });
    const rowH = Math.max(doc.heightOfString(`${label}:`, { width: labelW }), valueH) + 4;
    y = ensureSpace(doc, y, rowH);
    doc.font('Helvetica-Bold').fillColor('#475569').text(`${label}:`, left, y, { width: labelW });
    doc.font('Helvetica').fillColor('#0f172a').text(v, left + labelW, y, { width: valueW, lineGap: 2 });
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
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#334155');
    headers.forEach((h, i) => {
      doc.text(h, x + 5, y + 6, { width: colWidths[i] - 10, lineGap: 1 });
      x += colWidths[i];
    });
    doc.strokeColor('#94a3b8').lineWidth(0.5);
    doc.moveTo(left, y + headerH).lineTo(left + tableW, y + headerH).stroke();
    y += headerH;
  };

  drawHeader();

  doc.font('Helvetica').fontSize(9);
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

function statusLabel(match) {
  return match ? 'Match' : 'Mismatch';
}

function generateValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
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

  doc.fontSize(22).font('Helvetica-Bold').fillColor('#0f172a').text('Migration QA Validation Report', MARGIN, 50, {
    width: CONTENT_W,
    align: 'center',
  });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`Generated: ${new Date().toLocaleString()}`, {
    width: CONTENT_W,
    align: 'center',
  });
  doc.x = MARGIN;
  doc.moveDown(1.2);

  drawSectionHeader(doc, 'Execution details');
  drawMetadataTable(doc, [
    ['Execution ID', execution.executionId],
    ['Source email', context?.sourceEmail || 'N/A'],
    ['Destination email', context?.destinationEmail || 'N/A'],
    ['Test type', context?.testType || 'E2E'],
    ['Migration type', context?.migrationType || 'FULL'],
    ['Run status', result?.status || 'N/A'],
    ['Duration', result?.duration ? `${(result.duration / 1000).toFixed(1)} s` : 'N/A'],
    ['Started', execution.createdAt ? new Date(execution.createdAt).toLocaleString() : 'N/A'],
  ]);

  drawSectionHeader(doc, 'Overall status');
  doc.x = contentLeft(doc);
  const statusColor = validation?.overallStatus === 'PASS' ? '#15803d' : '#b91c1c';
  doc.fontSize(16).font('Helvetica-Bold').fillColor(statusColor).text(validation?.overallStatus || 'N/A');
  doc.moveDown(0.4);

  if (validation?.comparison) {
    const c = validation.comparison;
    doc.x = contentLeft(doc);
    doc.fontSize(10).font('Helvetica').fillColor('#334155');
    doc.text(
      `Default labels / folders: ${c.defaultLabelsMatch ? 'Match' : 'Mismatch'}  —  Custom labels / folders: ${c.customLabelsMatch ? 'Match' : 'Mismatch'}`,
      { width: CONTENT_W }
    );
    doc.moveDown(0.45);
  } else if (validation) {
    doc.moveDown(0.35);
  }

  if (!validation) {
    doc.x = contentLeft(doc);
    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('No validation data available.');
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
      doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('No custom labels on source.');
      doc.moveDown(0.35);
    }
  }

  // Immediately after label tables — stacked summaries (source + destination), no side-by-side page gaps
  if (mail) {
    doc.moveDown(0.2);
    drawSectionHeader(doc, 'Mail validation summary');
    drawMetadataTableCompact(doc, [
      ['Total messages (source)', String(mail.sourceCount ?? '—')],
      ['Total messages (destination)', String(mail.destinationCount ?? '—')],
      ['Folders mapped (destination scan)', String(mail.folderMapping?.length || 0)],
      ['Attachment checks', String(mail.attachmentChecks?.length || 0)],
    ]);
    if (includeCalendar && cal) {
      doc.moveDown(0.15);
      drawSectionHeader(doc, 'Calendar validation');
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

  if (validation.mismatches?.length > 0) {
    drawSectionHeader(doc, `Other mismatches (${validation.mismatches.length})`);
    const mw = [70, 120, CONTENT_W - 70 - 120];
    const misRows = validation.mismatches.map((m) => [
      m.category || '—',
      m.field || '—',
      `Expected: ${m.expected}  →  Actual: ${m.actual}`,
    ]);
    drawDataTable(doc, ['Category', 'Field', 'Expected vs actual'], misRows, mw);
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

/**
 * Generate a validation report PDF for a message / chat migration execution.
 */
function generateMessageValidationPdf(execution, stream) {
  const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
  doc.pipe(stream);

  const result     = execution.result || {};
  const context    = execution.context || {};
  const validation = result.validationSummary || {};
  const sourceData = result.sourceData        || {};
  const migration  = result.migrationResult   || {};

  // ── Title ──────────────────────────────────────────────────────────────────
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#0f172a')
    .text('Message Migration Validation Report', MARGIN, 50, { width: CONTENT_W, align: 'center' });
  doc.moveDown(0.25);
  doc.fontSize(10).font('Helvetica').fillColor('#64748b')
    .text(`Generated: ${new Date().toLocaleString()}`, { width: CONTENT_W, align: 'center' });
  doc.x = MARGIN;
  doc.moveDown(1);

  // ── Execution details ──────────────────────────────────────────────────────
  drawSectionHeader(doc, 'Execution details');
  drawMetadataTable(doc, [
    ['Execution ID',    execution.executionId],
    ['Source email',    context.sourceEmail || 'N/A'],
    ['Destination',     context.destinationEmail || 'N/A'],
    ['Combination',     validation.combination || context.messageCombination || 'N/A'],
    ['Test type',       context.testType || 'N/A'],
    ['Migration type',  context.migrationType || 'FULL'],
    ['Migration mode',  validation.migrationMode || migration.mode || 'N/A'],
    ['Run status',      result.status || 'N/A'],
    ['Duration',        result.duration ? `${(result.duration / 1000).toFixed(1)} s` : 'N/A'],
    ['Started',         execution.createdAt ? new Date(execution.createdAt).toLocaleString() : 'N/A'],
    ['Completed',       execution.completedAt ? new Date(execution.completedAt).toLocaleString() : 'N/A'],
  ]);

  // ── Overall status ─────────────────────────────────────────────────────────
  drawSectionHeader(doc, 'Overall validation status');
  const statusColor = validation.overallStatus === 'PASSED' ? '#15803d' : '#b91c1c';
  doc.x = contentLeft(doc);
  doc.fontSize(18).font('Helvetica-Bold').fillColor(statusColor)
    .text(validation.overallStatus || result.status || 'N/A');
  if (validation.isDryRun) {
    doc.fontSize(10).font('Helvetica').fillColor('#64748b')
      .text('(Dry-run mode — platform not connected live, messages were simulated)');
  }
  doc.moveDown(0.5);

  // ── Source seeding summary ─────────────────────────────────────────────────
  drawSectionHeader(doc, 'Source seeding summary');
  const counts = validation.counts || {};
  drawMetadataTableCompact(doc, [
    ['Test cases matched',    String(counts.testCases        || 0)],
    ['Targets (channels/DMs)', String(counts.targets         || 0)],
    ['Messages attempted',    String(counts.postsAttempted   || 0)],
    ['Messages posted ✓',     String(counts.postsSucceeded   || 0)],
    ['Messages failed ✗',     String(counts.postsFailed      || 0)],
    ['Live posting',          sourceData.livePosting || sourceData.liveSlackPosting ? 'Yes' : 'No (dry-run)'],
  ]);

  // ── CloudFuze migration summary ───────────────────────────────────────────
  drawSectionHeader(doc, 'CloudFuze migration summary');
  drawMetadataTableCompact(doc, [
    ['Migration mode',       migration.mode || validation.migrationMode || 'N/A'],
    ['CloudFuze API status', validation.cloudFuzeStatus || migration.cloudFuzeStatus || 'N/A'],
    ['Targets initiated',    String(counts.targetsInitiated ?? '—')],
    ['Targets failed',       String(counts.targetsFailed   ?? '—')],
    ['Messages migrated',    String(counts.messagesMigrated || 0)],
    ['Migration note',       validation.migrationNote || migration.note || '—'],
  ]);

  // ── Per-channel / DM breakdown ────────────────────────────────────────────
  const perTarget = validation.perTarget || [];
  if (perTarget.length > 0) {
    drawSectionHeader(doc, `Per-channel / DM breakdown (${perTarget.length} target${perTarget.length !== 1 ? 's' : ''})`);

    const colW = [180, 55, 55, 55, 70, 80];
    const headers = ['Target ID', 'Attempted', 'Posted ✓', 'Failed ✗', 'Migration', 'Status'];
    const rows = perTarget.map((t) => [
      t.id.length > 30 ? t.id.slice(0, 28) + '…' : t.id,
      String(t.seeding?.attempted || 0),
      String(t.seeding?.succeeded || 0),
      String(t.seeding?.failed    || 0),
      t.migration?.jobId ? `job: ${String(t.migration.jobId).slice(0, 12)}` : t.migration?.status || '—',
      t.status || '—',
    ]);
    drawDataTable(doc, headers, rows, colW);
  }

  // ── CloudFuze per-target job results ─────────────────────────────────────
  const cfResults = validation.chatMigrationResults || migration.chatMigrationResults || [];
  if (cfResults.length > 0) {
    drawSectionHeader(doc, 'CloudFuze job IDs per target');
    const colWcf = [200, 60, CONTENT_W - 260];
    const cfRows = cfResults.map((r) => [
      r.target.length > 35 ? r.target.slice(0, 33) + '…' : r.target,
      r.kind || '—',
      r.jobId ? `Job: ${r.jobId}` : (r.error ? `Error: ${r.error.slice(0, 60)}` : '—'),
    ]);
    drawDataTable(doc, ['Target ID', 'Kind', 'Result'], cfRows, colWcf);
  }

  // ── Mismatches ────────────────────────────────────────────────────────────
  const mismatches = validation.mismatches || [];
  if (mismatches.length > 0) {
    drawSectionHeader(doc, `Mismatches (${mismatches.length})`);
    const mwCols = [70, 130, CONTENT_W - 200];
    const misRows = mismatches.map((m) => [
      m.category || '—',
      m.field    || '—',
      `Expected: ${String(m.expected).slice(0, 60)}  →  Actual: ${String(m.actual).slice(0, 100)}`,
    ]);
    drawDataTable(doc, ['Category', 'Field', 'Expected vs actual'], misRows, mwCols);
  } else if (validation.overallStatus === 'PASSED') {
    doc.x = contentLeft(doc);
    doc.fontSize(10).font('Helvetica').fillColor('#15803d')
      .text('No mismatches detected — all validation checks passed.');
    doc.moveDown(0.3);
  }

  // ── Agent results ─────────────────────────────────────────────────────────
  const agentResults = result.agentResults || [];
  if (agentResults.length > 0) {
    drawSectionHeader(doc, 'Agent execution results');
    const arCols = [200, 80, CONTENT_W - 280];
    const arRows = agentResults.map((a) => [
      a.name || '—',
      a.status || '—',
      a.error  || (a.status === 'COMPLETED' ? 'Success' : '—'),
    ]);
    drawDataTable(doc, ['Agent', 'Status', 'Notes'], arRows, arCols);
  }

  doc.end();
}

module.exports = { generateValidationPdf, generateMessageValidationPdf };
