/**
 * Neutara Ticketing REST API client.
 * Raises bugs for failed migration QA executions.
 *
 * Auth:     Authorization: Bearer <NEUTARA_API_KEY>
 * Base URL: https://neutaraticketing.cftools.live/api
 * Create:   POST /api/issues  { summary, description, spaceKey, priority, type }
 */

const axios = require('axios');
const FormData = require('form-data');
const { Writable } = require('stream');
const env   = require('../config/env');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');
const { computeFunctionalityChecklist } = require('../validation/shared/functionalityChecklist');

const PROVIDER_LABELS = {
  google: 'Gmail', gmail: 'Gmail',
  microsoft: 'Outlook', outlook: 'Outlook',
  box: 'Box', sharepoint: 'SharePoint', onedrive: 'OneDrive',
  googledrive: 'Google Drive', dropbox: 'Dropbox',
};
function providerLabel(p) {
  return PROVIDER_LABELS[String(p || '').toLowerCase()] || (p ? String(p) : null);
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'N/A';
  const s = Math.round(n / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

// Resolve migrationJobDetails from the several places it may be persisted (matches pdfGenerator).
function resolveMigrationJob(execution) {
  const ctx = execution.context || {};
  const result = execution.result || {};
  return ctx.migrationJobDetails
    || result.migrationResult?.migrationJobDetails
    || result.validationSummary?.migrationJobDetails
    || null;
}

function baseUrl() {
  return String(env.NEUTARA_BASE_URL || 'https://neutaraticketing.cftools.live').replace(/\/$/, '');
}

function authHeader() {
  const key = env.NEUTARA_API_KEY;
  if (!key) throw new Error('NEUTARA_API_KEY must be set in .env');
  return `Bearer ${key}`;
}

function spaceKey() {
  return env.NEUTARA_SPACE || 'QT';
}

// ── Description builder (plain text — Neutara uses plain string, not ADF) ────

function buildDescription(execution) {
  const vs  = execution.result?.validationSummary || {};
  const ctx = execution.context || {};
  const mismatches = Array.isArray(vs.mismatches) ? vs.mismatches : [];

  const durationStr = formatDuration(execution.result?.duration);

  const lines = [];

  // ── Execution Details ──────────────────────────────────────────────────────
  const srcLabel = providerLabel(ctx.sourceProvider);
  const dstLabel = providerLabel(ctx.destinationProvider);
  const routeCombo = (srcLabel && dstLabel) ? ` (${srcLabel} → ${dstLabel})` : '';
  const migLabel = String(ctx.migrationType || '').toUpperCase() === 'DELTA' ? 'Delta' : 'One-time';

  lines.push('## Execution Details');
  lines.push(`Status:      ${vs.overallStatus || 'FAIL'}`);
  lines.push(`Route:       ${ctx.sourceEmail} → ${ctx.destinationEmail}${routeCombo}`);
  lines.push(`Test Type:   ${ctx.testType || 'E2E'}  |  Migration: ${migLabel}`);
  lines.push(`Duration:    ${durationStr}`);
  lines.push(`Execution:   ${execution.executionId || ctx.executionId || 'N/A'}`);
  lines.push('');

  // ── CloudFuze Migration Job ────────────────────────────────────────────────
  // Ties the bug to the actual migration run so a dev can pull the job in the CF console.
  const mj = resolveMigrationJob(execution);
  if (mj) {
    lines.push('## CloudFuze Migration Job');
    if (mj.serverUrl)   lines.push(`Server:      ${mj.serverUrl}`);
    if (mj.jobName)     lines.push(`Job Name:    ${mj.jobName}`);
    if (mj.jobId)       lines.push(`Job ID:      ${mj.jobId}`);
    if (mj.workspaceId) lines.push(`Workspace:   ${mj.workspaceId}`);
    if (mj.cfStatus)    lines.push(`CF Status:   ${mj.cfStatus}`);
    if (mj.totalCount != null) {
      const pct = mj.totalCount > 0 ? ` (${Math.round(((mj.processedCount || 0) / mj.totalCount) * 100)}%)` : '';
      lines.push(`Migrated:    ${mj.processedCount ?? 0} / ${mj.totalCount}${pct}`);
    }
    lines.push('');
  }

  // ── Validation Summary (metric roll-up — mirrors PDF Section 1) ────────────
  const dmv      = vs.deepMailValidation || {};
  const scanned  = dmv.scannedSourceMessages;
  const paired   = dmv.pairedCount;
  const unpaired = (scanned != null && paired != null) ? Math.max(0, scanned - paired) : null;
  const deepFailed = Array.isArray(dmv.messageResults)
    ? dmv.messageResults.filter((r) => !r.pass).length
    : null;

  lines.push('## Validation Summary');
  if (scanned != null)    lines.push(`Emails Checked:      ${scanned}`);
  if (paired != null)     lines.push(`Matched in Dest:     ${paired}`);
  if (unpaired != null)   lines.push(`Not Found in Dest:   ${unpaired}`);
  if (deepFailed != null) lines.push(`Content Mismatches:  ${deepFailed}`);
  lines.push(`Total Mismatches:    ${mismatches.length}`);
  if (dmv.summary) lines.push(`Deep Mail:           ${dmv.summary}`);
  lines.push('');

  // ── Failed Functionality Checks (mirrors PDF Section 2) ────────────────────
  // Feature-level roll-up: the clearest "what actually broke" view for a dev.
  try {
    const checklist = computeFunctionalityChecklist(
      vs, ctx.sourceProvider, ctx.destinationProvider, { migrationType: ctx.migrationType }
    );
    if (checklist) {
      const failed = checklist.families
        .flatMap((fam) => fam.features)
        .filter((f) => f.status === 'fail');
      const { pass, fail, na, total } = checklist.counts;
      if (failed.length > 0) {
        lines.push(`## Failed Functionality Checks (${fail} of ${total})`);
        failed.forEach((f) => lines.push(`✗ ${f.name} — ${f.evidence}`));
        lines.push(`(${pass} passed · ${na} not validated by this run)`);
        lines.push('');
      }
    }
  } catch (err) {
    logger.warn(`[neutaraClient] functionality checklist failed: ${err.message}`);
  }

  // ── Bucket mismatches ─────────────────────────────────────────────────────
  const bugMismatches     = mismatches.filter((m) => m.bugStatus !== 'known_limitation');
  const folderCountMismatches = bugMismatches.filter((m) => m.category === 'comparison');
  const notFound = bugMismatches.filter(
    (m) => m.category === 'deepMail' && m.kind === 'other'
      && (String(m.actual || '').includes('No Gmail message') || String(m.actual || '').includes('No Outlook message'))
  );
  const wrongFolder = bugMismatches.filter((m) => m.category === 'deepMail' && m.kind === 'folder');
  const threadChain = bugMismatches.filter((m) => m.category === 'deepMail' && m.kindLabel === 'Thread chain integrity');

  // ── Folder Count Mismatches ───────────────────────────────────────────────
  if (folderCountMismatches.length > 0) {
    lines.push(`## Folder Count Mismatches (${folderCountMismatches.length})`);
    for (const fm of folderCountMismatches) {
      const folderLabel = String(fm.field || '');
      const srcCount    = String(fm.expected || '').split(' ')[0] ?? '?';
      const dstCount    = String(fm.actual   || '').split(' ')[0] ?? '?';
      lines.push(`${folderLabel}: source ${srcCount} → destination ${dstCount}`);
    }
    lines.push('');
  }

  // ── Not Found in Destination (separate section — matches Jira) ───────────
  if (notFound.length > 0) {
    lines.push(`## Not Found in Destination (${notFound.length} messages)`);
    notFound.forEach((m) => lines.push(m.messageSubject || m.field || 'Unknown subject'));
    lines.push('');
  }

  // ── Wrong Folder / Label Placement ───────────────────────────────────────
  if (wrongFolder.length > 0) {
    lines.push(`## Wrong Folder / Label Placement (${wrongFolder.length} messages)`);
    wrongFolder.forEach((m) => {
      const folderDetail = String(m.actual || '').replace(/^folder:\s*/i, '').split(';')[0];
      const subj = m.messageSubject || m.field || '';
      lines.push(subj ? `${subj}  —  ${folderDetail}` : folderDetail);
    });
    lines.push('');
  }

  // ── Thread Chain Failures ─────────────────────────────────────────────────
  if (threadChain.length > 0) {
    lines.push(`## Thread Chain Failures (${threadChain.length})`);
    threadChain.forEach((m) => lines.push(m.summaryLine || m.messageSubject || m.field));
    lines.push('');
  }

  // ── AI Root Cause Analysis (matches Jira) ────────────────────────────────
  const ai = vs.aiAnalysis;
  if (ai?.rootCause && !ai.rootCause.startsWith('Analysis failed')) {
    lines.push('## AI Root Cause Analysis');
    lines.push(`Root Cause:    ${ai.rootCause}`);
    if (ai.suggestion) lines.push(`Suggested Fix: ${ai.suggestion}`);
    lines.push(`Fault Source:  ${ai.faultSource || 'unknown'}  |  Confidence: ${Math.round((ai.confidence || 0) * 100)}%`);
  }

  return lines.join('\n');
}

// ── Priority & Type decision ──────────────────────────────────────────────────

/**
 * Determine issue priority based on validation outcome:
 *
 * urgent  — >20 messages not found OR >5 folder mismatches OR infrastructure failure
 * high    — any messages not found OR folder count mismatches present
 * medium  — messages found but content mismatches (wrong folder, body, headers)
 * low     — only advisory / warning-level differences
 */
function decidePriority(mismatches) {
  const notFound = mismatches.filter(
    (m) => m.category === 'deepMail' && m.kind === 'other'
      && (String(m.actual || '').includes('No Gmail message') || String(m.actual || '').includes('No Outlook message'))
  );
  const folderMismatches  = mismatches.filter((m) => m.category === 'comparison');
  const infraFailures     = mismatches.filter((m) => m.kind === 'infrastructure');
  const criticalMismatches = mismatches.filter((m) => m.severity === 'critical');

  if (infraFailures.length > 0 || notFound.length > 20 || folderMismatches.length > 5 || criticalMismatches.length > 5) {
    return 'urgent';
  }
  if (notFound.length > 0 || folderMismatches.length > 0) {
    return 'high';
  }
  if (mismatches.filter((m) => m.severity === 'error').length > 0) {
    return 'medium';
  }
  return 'low';
}

/**
 * Determine issue type based on failure category:
 *
 * Bug   — migration failures: messages missing, wrong folder, content mismatch
 * Task  — infrastructure / connectivity failures (network, auth, API errors)
 */
function decideType(mismatches) {
  const allInfra = mismatches.length > 0
    && mismatches.every((m) => m.kind === 'infrastructure');
  return allInfra ? 'Task' : 'Bug';
}

// ── Validation report PDF attachment ──────────────────────────────────────────

/** Render the execution's validation report PDF into an in-memory Buffer. */
function generateValidationPdfBuffer(execution) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      // Required lazily to avoid a circular/startup dependency on pdfkit.
      const { generateValidationPdf } = require('../utils/pdfGenerator');
      generateValidationPdf(execution, sink);
    } catch (err) {
      reject(err);
    }
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Neutara's UI chip markup for an embedded file (base64 data-URI <a> with badge/name/size/⬇).
function buildPdfChip(buffer, filename) {
  const sizeKb = `${Math.max(1, Math.round(buffer.length / 1024))} KB`;
  const b64    = buffer.toString('base64');
  const style =
    'display: inline-flex; align-items: center; gap: 6px; background: rgb(241, 245, 249); '
    + 'border-width: 1px; border-color: rgb(226, 232, 240); border-radius: 8px; padding: 6px 10px; '
    + 'margin: 4px 2px; text-decoration: none; color: rgb(30, 64, 175); font-size: 12px;';
  return `<a href="data:application/pdf;base64,${b64}" download="${filename}" `
    + `data-filename="${filename}" data-filesize="${sizeKb}" style="${style}" contenteditable="false">`
    + '<span style="background:#3b82f6;color:white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:700;">PDF</span>'
    + `<span style="color:#374151;">${filename}</span>`
    + `<span style="color:#9ca3af;font-size:11px;">${sizeKb}</span>`
    + '<span style="color:#6b7280;font-size:11px;">⬇</span>'
    + '</a>';
}

// Upload the PDF as a real attachment via POST /api/issues/{cfKey}/attachments (multipart, field "file").
async function uploadPdf(issueKey, buffer, filename) {
  await retryWithBackoff(
    () => {
      // Rebuild the form each attempt — a form stream can only be consumed once.
      const form = new FormData();
      form.append('file', buffer, { filename, contentType: 'application/pdf' });
      return axios.post(
        `${baseUrl()}/api/issues/${issueKey}/attachments`,
        form,
        {
          headers: { ...form.getHeaders(), Authorization: authHeader() },
          timeout: 30000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );
    },
    { label: `neutaraClient uploadPdf (${issueKey})`, maxRetries: 3, baseDelay: 1500 }
  );
}

// Embed the PDF as a base64 data-URI chip in the description via PATCH — the method Neutara's UI uses.
async function embedPdf(issueKey, buffer, filename, description) {
  const html = `${escapeHtml(description || '').replace(/\n/g, '<br>')}`
    + `<br><br><strong>Validation Report (PDF):</strong> ${buildPdfChip(buffer, filename)}`;
  await retryWithBackoff(
    () => axios.patch(
      `${baseUrl()}/api/issues/${issueKey}`,
      { description: html },
      { headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }, timeout: 30000, maxBodyLength: Infinity }
    ),
    { label: `neutaraClient embedPdf (${issueKey})`, maxRetries: 3, baseDelay: 1500 }
  );
}

/**
 * Attach the validation report PDF to a just-created issue. Best-effort — never fails bug creation.
 * Mode via NEUTARA_ATTACH_MODE:
 *   'embed'  (default) — data-URI chip in the description. Renders reliably on the current Neutara
 *                        build. NOTE: the real multipart upload currently CRASHES Neutara's ticket
 *                        page (nameless-uploader render bug) and its /uploads route 404s the file,
 *                        so embed is the working choice until that frontend is patched.
 *   'upload'           — real POST /attachments. Switch to this once Neutara fixes the renderer + serving.
 *   'auto'             — try upload, fall back to embed.
 * Returns 'upload' | 'embed' | false.
 */
async function attachValidationPdf(issueKey, execution, description) {
  if (!issueKey) return false;
  let buffer;
  try {
    buffer = await generateValidationPdfBuffer(execution);
  } catch (err) {
    logger.warn(`[neutaraClient] PDF generation failed for ${issueKey}: ${err.message}`);
    return false;
  }
  const shortId  = String(execution.executionId || execution.context?.executionId || 'report').slice(0, 8);
  const filename = `validation-report-${shortId}.pdf`;
  const mode     = String(env.NEUTARA_ATTACH_MODE || 'embed').toLowerCase();

  const tryUpload = async () => { await uploadPdf(issueKey, buffer, filename); logger.info(`[neutaraClient] Attached ${filename} to ${issueKey} (upload)`); return 'upload'; };
  const tryEmbed  = async () => { await embedPdf(issueKey, buffer, filename, description); logger.info(`[neutaraClient] Embedded ${filename} in ${issueKey} description`); return 'embed'; };

  try {
    if (mode === 'upload') return await tryUpload();
    if (mode === 'auto') {
      try { return await tryUpload(); }
      catch (e) { logger.warn(`[neutaraClient] upload failed for ${issueKey} (${e.response?.data ? JSON.stringify(e.response.data) : e.message}) — embedding instead`); }
    }
    return await tryEmbed();
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.warn(`[neutaraClient] attachValidationPdf failed for ${issueKey}: ${detail}`);
    return false;
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function createBug(execution) {
  if (!env.NEUTARA_API_KEY) {
    logger.warn('[neutaraClient] NEUTARA_API_KEY not set — skipping bug creation');
    return null;
  }

  const vs  = execution.result?.validationSummary || {};
  const ctx = execution.context || {};
  const mismatches    = Array.isArray(vs.mismatches) ? vs.mismatches : [];
  const bugMismatches = mismatches.filter((m) => m.bugStatus !== 'known_limitation');
  const limitCount    = mismatches.length - bugMismatches.length;
  const bugCount      = bugMismatches.length;

  // Skip ticket if everything is a known limitation — no real bugs to report
  if (bugCount === 0 && limitCount > 0) {
    logger.info(`[neutaraClient] All ${limitCount} mismatch(es) are known limitations — skipping bug creation`);
    return { knownLimitationsOnly: true, count: limitCount };
  }

  const priority = decidePriority(bugMismatches);
  const type     = decideType(bugMismatches);

  const summary =
    `[Migration QA] FAIL: ${ctx.sourceEmail} → ${ctx.destinationEmail}` +
    ` | ${ctx.testType || 'E2E'} | ${mismatches.length} mismatch(es)`;

  const body = {
    summary,
    description: buildDescription(execution),
    spaceKey: spaceKey(),
    type,
    priority,
    // Leave bugs unassigned — otherwise Neutara auto-assigns to the API key owner.
    // Both keys are sent because the API returns `assignee` but historically accepts `assigneeId` on write.
    assignee: null,
    assigneeId: null,
    // Force the reporter to the QA Agent identity. Without this, Neutara sets the
    // reporter to the API key's owner. reporterEmail is the field the API honors
    // (reporterId is ignored).
    reporterEmail: env.NEUTARA_REPORTER_EMAIL || 'qaagent@cloudfuze.com',
  };

  logger.info(`[neutaraClient] Raising ${type} with priority=${priority} (${bugCount} bug(s), ${limitCount} known limitation(s))`);

  try {
    // Retry on transient 5xx / network errors. In bulk runs, multiple pairs fire createBug
    // near-simultaneously; Neutara has been seen to 500 on the concurrent second create, so a
    // backoff retry (by which time the first has completed) recovers the dropped ticket.
    // 4xx errors are not retried (retryWithBackoff breaks on 400-499 except 429).
    const res = await retryWithBackoff(
      () => axios.post(
        `${baseUrl()}/api/issues`,
        body,
        {
          headers: {
            Authorization: authHeader(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          timeout: 15000,
        }
      ),
      { label: `neutaraClient createBug (${ctx.sourceEmail} → ${ctx.destinationEmail})`, maxRetries: 4, baseDelay: 1500 }
    );

    const key = res.data?.key || res.data?.id;
    // The attachment endpoint keys issues by the CF- key (per api.ts: uploadAttachment(issueKey, file)
    // called as /api/issues/CF-123/attachments). Prefer cfKey, fall back to the canonical key.
    const attachKey = res.data?.cfKey || key;
    const url = `${baseUrl()}/issues/${res.data?.cfKey || key}`;
    logger.info(`[neutaraClient] ${type} created: ${key} (${attachKey})  ${url}`);

    // Attach the full validation report PDF (best-effort — never fails the ticket).
    // Returns 'upload' (real endpoint), 'embed' (data-URI fallback), or false.
    let pdfAttached = false;
    if (env.NEUTARA_ATTACH_PDF !== 'false') {
      pdfAttached = await attachValidationPdf(attachKey, execution, body.description);
    }

    return { key, url, pdfAttached };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[neutaraClient] createBug error: ${detail}`);
    return null;
  }
}

module.exports = { createBug };
