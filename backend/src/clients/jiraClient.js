/**
 * Jira Cloud REST API v3 — Bug creation for failed migration QA executions.
 *
 * Called by AgentOrchestrator after any execution whose validationSummary.overallStatus === 'FAIL'.
 * Creates one Bug issue per failed execution summarising which folders/messages failed.
 */

const axios = require('axios');
const env = require('../config/env');
const logger = require('../utils/logger');

// ── helpers ──────────────────────────────────────────────────────────────────

function baseUrl() {
  // Strip trailing /jira or slash so API paths join cleanly
  return String(env.JIRA_BASE_URL || 'https://cf2020.atlassian.net')
    .replace(/\/jira\/?$/, '')
    .replace(/\/$/, '');
}

function authHeader() {
  const user = env.JIRA_USER || env.JIRA_EMAIL;
  const token = env.JIRA_API_TOKEN;
  if (!user || !token) throw new Error('JIRA_USER and JIRA_API_TOKEN must be set in .env');
  return 'Basic ' + Buffer.from(`${user}:${token}`, 'utf8').toString('base64');
}

function projectKey() {
  return env.JIRA_PROJECT_KEY || 'AQE';
}

// Cache the resolved reporter accountId for the session
let _reporterAccountId = null;

async function resolveReporterAccountId() {
  if (_reporterAccountId) return _reporterAccountId;

  // 1. Prefer explicit env override
  if (env.JIRA_REPORTER_ACCOUNT_ID) {
    _reporterAccountId = env.JIRA_REPORTER_ACCOUNT_ID;
    return _reporterAccountId;
  }

  // 2. Auto-fetch the current API user's accountId via GET /rest/api/3/myself
  try {
    const res = await axios.get(`${baseUrl()}/rest/api/3/myself`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      timeout: 10000,
    });
    _reporterAccountId = res.data?.accountId || null;
    if (_reporterAccountId) {
      logger.info(`[jiraClient] Reporter accountId resolved: ${_reporterAccountId} (${res.data?.displayName})`);
    }
  } catch (err) {
    logger.warn(`[jiraClient] Could not resolve reporter accountId: ${err.message}`);
  }

  return _reporterAccountId;
}

// ── ADF (Atlassian Document Format) builder ──────────────────────────────────

const adf = {
  doc: (...content) => ({ version: 1, type: 'doc', content }),
  para: (...inline) => ({ type: 'paragraph', content: inline }),
  text: (t) => ({ type: 'text', text: String(t) }),
  bold: (t) => ({ type: 'text', text: String(t), marks: [{ type: 'strong' }] }),
  rule: () => ({ type: 'rule' }),
  heading: (level, text) => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }],
  }),
  bulletList: (items) => ({
    type: 'bulletList',
    content: items.map((text) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text) }] }],
    })),
  }),
};

// ── description builder ───────────────────────────────────────────────────────

function buildDescription(execution) {
  const vs = execution.result?.validationSummary || {};
  const ctx = execution.context || {};
  const mismatches = Array.isArray(vs.mismatches) ? vs.mismatches : [];

  // Duration formatting
  const durationMs = execution.result?.duration || 0;
  const durationStr = durationMs
    ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
    : 'N/A';

  // Server URL — prefer migrationJobDetails (set during run), fall back to context
  const serverUrl =
    execution.result?.migrationResult?.migrationJobDetails?.serverUrl ||
    ctx.migrationServerUrl ||
    null;

  // ── bucket mismatches by type ──────────────────────────────────────────────
  const folderCountMismatches = mismatches.filter((m) => m.category === 'comparison');
  const notFound = mismatches.filter(
    (m) => m.category === 'deepMail' && m.kind === 'other'
      && (String(m.actual || '').includes('No Gmail message') || String(m.actual || '').includes('No Outlook message'))
  );
  const wrongFolder = mismatches.filter(
    (m) => m.category === 'deepMail' && m.kind === 'folder'
  );
  const threadChain = mismatches.filter(
    (m) => m.category === 'deepMail' && m.kindLabel === 'Thread chain integrity'
  );
  const other = mismatches.filter(
    (m) => !folderCountMismatches.includes(m) && !notFound.includes(m)
      && !wrongFolder.includes(m) && !threadChain.includes(m)
  );

  const nodes = [];

  // ── Execution Details ──────────────────────────────────────────────────────
  const migJob = execution.result?.migrationResult?.migrationJobDetails || {};
  const workspaceId = migJob.workspaceId || '—';
  const cfStatus    = migJob.cfStatus    || '—';

  nodes.push(adf.heading(2, 'Execution Details'));
  const srcProvider  = String(ctx.sourceProvider      || 'unknown').toLowerCase();
  const dstProvider  = String(ctx.destinationProvider || 'unknown').toLowerCase();
  const srcLabel     = srcProvider === 'microsoft' ? 'Outlook' : srcProvider === 'google' ? 'Gmail' : srcProvider;
  const dstLabel     = dstProvider === 'microsoft' ? 'Outlook' : dstProvider === 'google' ? 'Gmail' : dstProvider;
  const combination  = `${srcLabel} → ${dstLabel}`;

  nodes.push(adf.para(adf.bold('QA Agent Run ID:  '), adf.text(execution.executionId || ctx.executionId || 'N/A')));
  nodes.push(adf.para(adf.bold('Direction:        '), adf.text(`${ctx.sourceEmail} → ${ctx.destinationEmail}`)));
  nodes.push(adf.para(adf.bold('Combination:      '), adf.text(combination)));
  nodes.push(adf.para(adf.bold('Test Type:        '), adf.text(`${ctx.testType || 'E2E'}  |  Migration: ${ctx.migrationType || 'FULL'}`)));
  nodes.push(adf.para(adf.bold('Server:           '), adf.text(serverUrl || '—')));
  nodes.push(adf.para(adf.bold('CF Workspace ID:  '), adf.text(String(workspaceId))));
  nodes.push(adf.para(adf.bold('CF Status:        '), adf.text(String(cfStatus))));
  nodes.push(adf.para(adf.bold('Duration:         '), adf.text(durationStr)));
  nodes.push(adf.para(adf.bold('Total Mismatches: '), adf.text(String(mismatches.length))));

  // deep mail summary line
  const dms = vs.deepMailValidation?.summary;
  if (dms) nodes.push(adf.para(adf.bold('Deep Mail:   '), adf.text(dms)));

  nodes.push(adf.rule());

  // ── Folder Mismatches + Not Found (combined) ─────────────────────────────
  // Groups missing messages under the folder they came from.
  // Folder info is stored in structuredDiffs[fieldKey='folder'].sourceExpected
  // (populated by deepMailValidator after the not-found fix).
  if (folderCountMismatches.length > 0 || notFound.length > 0) {
    nodes.push(adf.heading(3,
      `Mismatches in ${folderCountMismatches.length} Folder${folderCountMismatches.length !== 1 ? 's' : ''} with ${notFound.length} Mail${notFound.length !== 1 ? 's' : ''}`
    ));

    const assignedFields = new Set();

    for (const fm of folderCountMismatches) {
      const folderLabel = String(fm.field || '');
      const srcCount    = String(fm.expected || '').split(' ')[0] ?? '?';
      const dstCount    = String(fm.actual   || '').split(' ')[0] ?? '?';
      const fLeaf       = folderLabel.split('/').pop() || '';

      nodes.push(adf.para(
        adf.bold(`${folderLabel}: `),
        adf.text(`source ${srcCount} → destination ${dstCount}`)
      ));

      // Match not-found messages to this folder via structuredDiffs folder row
      const folderMsgs = notFound.filter((m) => {
        const msgFolder = m.structuredDiffs?.find((d) => d.fieldKey === 'folder')?.sourceExpected || '';
        if (!msgFolder) return false;
        const mLeaf = msgFolder.split('/').pop() || '';
        return msgFolder === folderLabel || (fLeaf && mLeaf && fLeaf === mLeaf);
      });

      if (folderMsgs.length > 0) {
        nodes.push(adf.para(adf.text('Not migrated mails at destination:')));
        nodes.push(adf.bulletList(folderMsgs.map((m) => m.messageSubject || 'Unknown subject')));
        folderMsgs.forEach((m) => assignedFields.add(m.field));
      }
    }

    // Messages without folder info (older executions before the not-found fix)
    const unassigned = notFound.filter((m) => !assignedFields.has(m.field));
    if (unassigned.length > 0) {
      nodes.push(adf.para(adf.bold('Not migrated mails (folder info unavailable):')));
      nodes.push(adf.bulletList(unassigned.map((m) => m.messageSubject || 'Unknown subject')));
    }
  }

  // ── Wrong Folder Placement ────────────────────────────────────────────────
  if (wrongFolder.length > 0) {
    nodes.push(adf.heading(3, `Wrong Folder / Label Placement (${wrongFolder.length} messages)`));
    nodes.push(
      adf.bulletList(
        wrongFolder.map((m) => {
          // actual contains "folder: expected X / actual Y"
          const folderDetail = String(m.actual || '').replace(/^folder:\s*/i, '').split(';')[0];
          const subj = m.messageSubject || m.field || '';
          return subj ? `${subj}  —  ${folderDetail}` : folderDetail;
        })
      )
    );
  }

  // ── Thread Chain Failures ─────────────────────────────────────────────────
  if (threadChain.length > 0) {
    nodes.push(adf.heading(3, `Thread Chain Failures (${threadChain.length})`));
    nodes.push(
      adf.bulletList(threadChain.map((m) => m.summaryLine || m.messageSubject || m.field))
    );
  }

  // ── Other mismatches ──────────────────────────────────────────────────────
  if (other.length > 0) {
    nodes.push(adf.heading(3, `Other Mismatches (${other.length})`));
    nodes.push(adf.bulletList(other.map((m) => m.summaryLine || m.field || 'Unknown')));
  }

  // ── AI Root Cause ─────────────────────────────────────────────────────────
  const ai = vs.aiAnalysis;
  if (ai && ai.rootCause && !ai.rootCause.startsWith('Analysis failed')) {
    nodes.push(adf.rule());
    nodes.push(adf.heading(3, 'AI Root Cause Analysis'));
    nodes.push(adf.para(adf.bold('Root Cause: '), adf.text(ai.rootCause)));
    if (ai.suggestion) {
      nodes.push(adf.para(adf.bold('Suggested Fix: '), adf.text(ai.suggestion)));
    }
    nodes.push(adf.para(
      adf.bold('Fault Source: '),
      adf.text(`${ai.faultSource || 'unknown'}  |  Confidence: ${Math.round((ai.confidence || 0) * 100)}%`)
    ));
  }

  return adf.doc(...nodes);
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Creates a Jira Bug for a failed execution.
 * Returns { key, url } on success, null on failure or when Jira is not configured.
 *
 * @param {object} execution  - full execution object (executionId, context, result)
 */
async function createBug(execution) {
  if (!env.JIRA_API_TOKEN) {
    logger.warn('[jiraClient] JIRA_API_TOKEN not set — skipping bug creation');
    return null;
  }

  const vs = execution.result?.validationSummary || {};
  const ctx = execution.context || {};
  const mismatchCount = Array.isArray(vs.mismatches) ? vs.mismatches.length : 0;

  const summary =
    `[Migration QA] FAIL: ${ctx.sourceEmail} → ${ctx.destinationEmail}` +
    ` | ${ctx.testType || 'E2E'} | ${mismatchCount} mismatch(es)`;

  const reporterAccountId = await resolveReporterAccountId();

  const body = {
    fields: {
      project: { key: projectKey() },
      summary,
      description: buildDescription(execution),
      issuetype: { name: env.JIRA_BUG_ISSUE_TYPE || 'Bug' },
      labels: [
        'migration-qa',
        `${ctx.sourceProvider || 'unknown'}-to-${ctx.destinationProvider || 'unknown'}`,
      ],
      ...(reporterAccountId && { reporter: { id: reporterAccountId } }),
    },
  };

  try {
    const res = await axios.post(
      `${baseUrl()}/rest/api/3/issue`,
      body,
      {
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 15000,
      }
    );

    if (res.status >= 400) {
      const errBody = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
      logger.error(`[jiraClient] Create bug failed HTTP ${res.status}: ${errBody}`);
      return null;
    }

    const key = res.data?.key;
    const url = `${baseUrl()}/browse/${key}`;
    logger.info(`[jiraClient] Bug created: ${key}  ${url}`);
    return { key, url };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    logger.error(`[jiraClient] createBug error: ${detail}`);
    return null;
  }
}

module.exports = { createBug };
