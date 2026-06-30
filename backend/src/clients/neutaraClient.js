/**
 * Neutara Ticketing REST API client.
 * Raises bugs for failed migration QA executions.
 *
 * Auth:     Authorization: Bearer <NEUTARA_API_KEY>
 * Base URL: https://neutaraticketing.cftools.live/api
 * Create:   POST /api/issues  { summary, description, spaceKey, priority, type }
 */

const axios = require('axios');
const env   = require('../config/env');
const logger = require('../utils/logger');
const { retryWithBackoff } = require('../utils/retry');

function baseUrl() {
  return String(env.NEUTARA_BASE_URL || 'https://neutaraticketing.cftools.live').replace(/\/$/, '');
}

function authHeader() {
  const key = env.NEUTARA_API_KEY;
  if (!key) throw new Error('NEUTARA_API_KEY must be set in .env');
  return `Bearer ${key}`;
}

function spaceKey() {
  return env.NEUTARA_SPACE || 'AQ';
}

// ── Description builder (plain text — Neutara uses plain string, not ADF) ────

function buildDescription(execution) {
  const vs  = execution.result?.validationSummary || {};
  const ctx = execution.context || {};
  const mismatches = Array.isArray(vs.mismatches) ? vs.mismatches : [];

  const durationMs  = execution.result?.duration || 0;
  const durationStr = durationMs
    ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
    : 'N/A';

  const lines = [];

  // ── Execution Details (matches Jira format) ────────────────────────────────
  lines.push('## Execution Details');
  lines.push(`ID:          ${execution.executionId || ctx.executionId || 'N/A'}`);
  lines.push(`Direction:   ${ctx.sourceEmail} → ${ctx.destinationEmail}`);
  lines.push(`Test Type:   ${ctx.testType || 'E2E'}  |  Migration: ${ctx.migrationType || 'FULL'}`);
  lines.push(`Duration:    ${durationStr}`);
  lines.push(`Total Mismatches: ${mismatches.length}`);

  const dms = vs.deepMailValidation?.summary;
  if (dms) lines.push(`Deep Mail:   ${dms}`);
  lines.push('');

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
    const url = `${baseUrl()}/issues/${key}`;
    logger.info(`[neutaraClient] Bug created: ${key}  ${url}`);
    return { key, url };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[neutaraClient] createBug error: ${detail}`);
    return null;
  }
}

module.exports = { createBug };
