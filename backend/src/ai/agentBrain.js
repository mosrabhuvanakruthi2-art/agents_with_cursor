const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const grafanaClient = require('../clients/grafanaClient');

const MODEL = 'gpt-4o';

const SYSTEM_PROMPT = `You are an expert email migration QA engineer analyzing results from a Gmail↔Outlook migration platform. \
You have deep knowledge of IMAP, Microsoft Graph API, Exchange Web Services (EWS), MIME standards, and common migration failure patterns.

When analyzing failures, be concise and actionable. Always structure your output as valid JSON.

Key migration concepts you understand:
- Tier A: subject, from, to, cc, attachments presence, replyTo
- Tier B: SHA-256 attachment content hash verification
- Tier C: normalized plain-text body comparison
- Common failure causes: throttling, encoding drift, timezone normalization, MIME boundary issues,
  EWS/Graph field restrictions, attachment size limits, folder mapping errors, read-state flips,
  category/label mapping, importance/flag mapping, sensitivity labels, thread chain mismatches

Expected source message counts by test type (use these to judge whether source data was created correctly):
- SMOKE:  Outlook source ~5 msgs | Gmail source ~2 msgs
- SANITY: Outlook source ~20 msgs | Gmail source ~15 msgs
- E2E:    Outlook source ~200+ msgs | Gmail source ~50+ msgs`;

const EXPECTED_SOURCE_COUNTS = {
  SMOKE:  { microsoft: { min: 3,  max: 10  }, google: { min: 1,  max: 5   } },
  SANITY: { microsoft: { min: 15, max: 30  }, google: { min: 10, max: 25  } },
  E2E:    { microsoft: { min: 150, max: 500 }, google: { min: 40, max: 200 } },
};

const LOG_DIR = path.resolve(__dirname, '../../logs');

// ── OpenAI client ─────────────────────────────────────────────────────────────

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY environment variable not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

async function chat(userContent, maxTokens = 1500) {
  const client = getClient();
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '';
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// ── pre-classification ────────────────────────────────────────────────────────

function preClassifyFaultSource(validationResult, context) {
  const { testType = 'E2E', sourceProvider = 'google' } = context || {};
  const sourceCount = validationResult?.mailValidation?.sourceCount ?? -1;
  if (sourceCount < 0) return null;

  const providerKey = sourceProvider === 'microsoft' ? 'microsoft' : 'google';
  const expected = EXPECTED_SOURCE_COUNTS[testType.toUpperCase()]?.[providerKey];
  if (!expected) return null;

  if (sourceCount < expected.min * 0.5) return 'test_data_creation';

  const hasComparisonIssues = (validationResult?.comparison?.issues?.length ?? 0) > 0;
  if (sourceCount >= expected.min && hasComparisonIssues) return 'migration';

  return null;
}

// ── local execution log reader ────────────────────────────────────────────────

/**
 * Reads the per-execution log file and extracts relevant lines.
 * Returns { available, lines, errors, warnings, agentSteps }
 */
function readExecutionLog(executionId) {
  if (!executionId) return { available: false };
  const logFile = path.join(LOG_DIR, `${executionId}.log`);
  if (!fs.existsSync(logFile)) return { available: false, reason: 'Log file not found' };

  try {
    const raw = fs.readFileSync(logFile, 'utf-8').trim();
    const rawLines = raw.split('\n').filter(Boolean);

    const parsed = rawLines.map((l) => {
      try { return JSON.parse(l); } catch { return { message: l, level: 'info' }; }
    });

    const errors   = parsed.filter((l) => l.level === 'error');
    const warnings = parsed.filter((l) => l.level === 'warn');
    const agentSteps = parsed.filter((l) => /Step \d+:|Agent (started|completed)/i.test(l.message || ''));

    // Migration-specific lines: initiate, polling, completion
    const migrationLines = parsed.filter((l) =>
      /triggerMigration|initiat|poll|Migration (complete|initiated)|workspace|processedCount/i.test(l.message || '')
    );

    return {
      available: true,
      totalLines: rawLines.length,
      errors: errors.slice(0, 30),
      warnings: warnings.slice(0, 30),
      agentSteps,
      migrationLines: migrationLines.slice(0, 20),
      // Last 40 lines for context
      tail: parsed.slice(-40),
    };
  } catch (err) {
    return { available: false, reason: `Read error: ${err.message}` };
  }
}

/**
 * Format log evidence into a compact string section for the GPT prompt.
 */
function formatLogEvidence(execLog, grafanaEvidence) {
  const parts = [];

  if (execLog?.available) {
    parts.push(`=== QA Agent Execution Log (${execLog.totalLines} lines total) ===`);

    if (execLog.agentSteps.length) {
      parts.push('Agent steps:');
      execLog.agentSteps.forEach((l) => parts.push(`  [${l.timestamp || ''}] ${l.message}`));
    }
    if (execLog.migrationLines.length) {
      parts.push('Migration events:');
      execLog.migrationLines.forEach((l) => parts.push(`  [${l.timestamp || ''}] ${l.message}`));
    }
    if (execLog.errors.length) {
      parts.push(`Errors (${execLog.errors.length}):`);
      execLog.errors.forEach((l) => parts.push(`  ERROR [${l.timestamp || ''}] ${l.message}`));
    }
    if (execLog.warnings.length) {
      parts.push(`Warnings (first 15):`);
      execLog.warnings.slice(0, 15).forEach((l) => parts.push(`  WARN  [${l.timestamp || ''}] ${l.message}`));
    }
  }

  if (grafanaEvidence?.available) {
    parts.push(`\n=== Grafana / CloudFuze Server Logs (${grafanaEvidence.totalLines} lines fetched) ===`);

    const ev = grafanaEvidence.evidence || {};
    if (ev.errors?.length) {
      parts.push(`Server Errors (${ev.errors.length}):`);
      ev.errors.forEach(({ ts, line }) => parts.push(`  [${ts}] ${line}`));
    }
    if (ev.archiveRelated?.length) {
      parts.push(`Archive-related log lines (${ev.archiveRelated.length}):`);
      ev.archiveRelated.forEach(({ ts, line }) => parts.push(`  [${ts}] ${line}`));
    }
    if (ev.folderMappingIssues?.length) {
      parts.push('Folder mapping log lines:');
      ev.folderMappingIssues.forEach(({ folder, logLines }) => {
        parts.push(`  Folder "${folder}":`);
        logLines.forEach(({ ts, line }) => parts.push(`    [${ts}] ${line}`));
      });
    }
    if (ev.missingMessageHints?.length) {
      parts.push('Log hints for missing messages:');
      ev.missingMessageHints.forEach(({ subject, logLines }) => {
        parts.push(`  Subject: "${subject}"`);
        logLines.forEach(({ ts, line }) => parts.push(`    [${ts}] ${line}`));
      });
    }
    if (ev.throttlingOrRateLimit?.length) {
      parts.push(`Throttling / rate-limit events (${ev.throttlingOrRateLimit.length}):`);
      ev.throttlingOrRateLimit.forEach(({ ts, line }) => parts.push(`  [${ts}] ${line}`));
    }
    if (ev.authErrors?.length) {
      parts.push(`Auth errors (${ev.authErrors.length}):`);
      ev.authErrors.forEach(({ ts, line }) => parts.push(`  [${ts}] ${line}`));
    }
  } else if (grafanaEvidence && !grafanaEvidence.available) {
    parts.push(`\nGrafana logs: not available (${grafanaEvidence.reason || 'not configured'})`);
  }

  return parts.join('\n');
}

// ── AgentBrain class ──────────────────────────────────────────────────────────

class AgentBrain {
  /**
   * Standard validation failure analysis (no logs).
   */
  async analyzeFailure(validationResult, context = {}) {
    try {
      const { testType = 'E2E', direction = 'unknown', sourceProvider = 'google', destinationProvider = 'microsoft' } = context;
      const preClassified = preClassifyFaultSource(validationResult, context);

      const jobDetails = validationResult?.migrationJobDetails;
      const jobSection = jobDetails
        ? `CloudFuze migration job:
- Workspace ID: ${jobDetails.workspaceId ?? 'unknown'}
- Status: ${jobDetails.cfStatus ?? 'unknown'}
- Processed / Total: ${jobDetails.processedCount ?? '?'} / ${jobDetails.totalCount ?? '?'}
- Gap (unprocessed): ${jobDetails.totalCount != null && jobDetails.processedCount != null ? jobDetails.totalCount - jobDetails.processedCount : 'unknown'}`
        : 'CloudFuze migration job: not available';

      const prompt = `Analyze this migration validation failure and determine both the root cause AND where the fault lies.

Migration context:
- Direction: ${direction}
- Source provider: ${sourceProvider}
- Destination provider: ${destinationProvider}
- Test type: ${testType}
- Pre-classification hint (may be null if inconclusive): ${preClassified ?? 'null'}

${jobSection}

Validation result:
${JSON.stringify(validationResult, null, 2)}

Fault source classification rules:
- "test_data_creation": source mailbox counts are anomalously low/zero for the given testType,
  or source folders are missing that the TestDataAgent should have created.
- "migration": source counts look correct for the testType but destination counts differ,
  or destination is missing folders/labels that exist at source. Use CloudFuze job data to make
  faultEvidence specific — reference workspace ID, processed/total counts, final status.
- "unknown": cannot determine from the available data.

Respond with a JSON object:
{
  "rootCause": "one-sentence root cause",
  "tier": "A|B|C|placement|thread|unknown",
  "confidence": 0.0-1.0,
  "suggestion": "specific actionable fix",
  "affectedFields": ["field1", "field2"],
  "faultSource": "test_data_creation|migration|unknown",
  "faultEvidence": "cite workspace ID, processed/total counts, and status where available"
}`;

      const raw = await chat(prompt);
      const parsed = JSON.parse(raw);

      if (parsed.faultSource === 'unknown' && preClassified) {
        parsed.faultSource = preClassified;
        parsed.faultEvidence = `${parsed.faultEvidence || ''} (overridden by count threshold check)`.trim();
      }

      return { ...parsed, mismatches: validationResult?.mismatches?.length ?? 0 };
    } catch (err) {
      return {
        rootCause: `Analysis failed: ${err.message}`,
        tier: 'unknown',
        confidence: 0,
        suggestion: err.message.includes('OPENAI_API_KEY') ? 'Set OPENAI_API_KEY environment variable' : 'Check server logs',
        mismatches: validationResult?.mismatches?.length ?? 0,
        affectedFields: [],
        faultSource: 'unknown',
        faultEvidence: `Analysis error: ${err.message}`,
      };
    }
  }

  /**
   * Deep log-backed analysis: reads local execution log + queries Grafana,
   * then sends everything to GPT-4o for evidence-backed root cause analysis.
   *
   * @param {Object} validationResult  - ValidationResult.toJSON()
   * @param {Object} context           - MigrationContext fields
   * @param {string} executionId       - UUID for reading local log file
   * @param {Date}   startTime         - execution start (for Grafana time range)
   * @param {Date}   endTime           - execution end
   * @returns {Promise<Object>}
   *   { rootCause, tier, confidence, suggestion, affectedFields, faultSource,
   *     faultEvidence, logProof, grafanaAvailable, localLogAvailable }
   */
  async analyzeMigrationLogs(validationResult, context = {}, executionId, startTime, endTime) {
    const {
      testType = 'E2E',
      direction = 'unknown',
      sourceProvider = 'google',
      destinationProvider = 'microsoft',
    } = context;

    // ── 1. read local execution log ──────────────────────────────────────────
    const execLog = readExecutionLog(executionId);

    // ── 2. query Grafana for CloudFuze server logs ───────────────────────────
    let grafanaResult = { available: false, reason: 'not attempted' };
    const jobDetails = validationResult?.migrationJobDetails || context.migrationJobDetails;
    const tStart = startTime instanceof Date ? startTime : new Date(startTime || Date.now() - 3600000);
    const tEnd   = endTime   instanceof Date ? endTime   : new Date(endTime   || Date.now());

    try {
      grafanaResult = await grafanaClient.searchMigrationLogs(
        context,
        jobDetails,
        tStart,
        tEnd,
        validationResult?.mismatches || []
      );
    } catch (err) {
      grafanaResult = { available: false, reason: err.message };
    }

    // ── 3. build log evidence section for prompt ─────────────────────────────
    const logSection = formatLogEvidence(execLog, grafanaResult);

    // ── 4. pre-classify ──────────────────────────────────────────────────────
    const preClassified = preClassifyFaultSource(validationResult, context);

    const jobSection = jobDetails
      ? `CloudFuze migration job:
- Workspace ID: ${jobDetails.workspaceId ?? 'unknown'}
- Status: ${jobDetails.cfStatus ?? 'unknown'}
- Processed / Total: ${jobDetails.processedCount ?? '?'} / ${jobDetails.totalCount ?? '?'}`
      : 'CloudFuze migration job: not available';

    // ── 5. build slim mismatch summary (avoid huge payload) ─────────────────
    const mismatchSummary = (validationResult?.mismatches || []).map((m) => ({
      category: m.category,
      kind: m.kind,
      field: m.field,
      expected: String(m.expected || '').substring(0, 120),
      actual: String(m.actual || '').substring(0, 120),
      messageSubject: m.messageSubject || '',
      summaryLine: String(m.summaryLine || '').substring(0, 200),
    }));

    // ── 6. prompt ────────────────────────────────────────────────────────────
    const prompt = `You are investigating a failed email migration. Use the log evidence below to identify the EXACT point of failure with specific log line citations.

Migration context:
- Direction: ${direction}
- Source: ${sourceProvider} (${context.sourceEmail || ''})
- Destination: ${destinationProvider} (${context.destinationEmail || ''})
- Test type: ${testType}
- Pre-classification hint: ${preClassified ?? 'null'}

${jobSection}

Validation mismatches (${mismatchSummary.length} total):
${JSON.stringify(mismatchSummary, null, 2)}

${logSection}

Instructions:
1. Identify the root cause using specific log lines as proof. Quote exact log messages.
2. For each mismatch category, cite the log line(s) that explain WHY it failed.
3. Distinguish between:
   - CloudFuze server-side failures (from Grafana logs)
   - QA agent / API call failures (from execution log)
4. State whether the issue is a migration bug, config problem, or API/auth issue.
5. Provide the log timestamp of when the failure first appeared.

Respond with a JSON object:
{
  "rootCause": "one-sentence root cause",
  "tier": "A|B|C|placement|thread|config|auth|unknown",
  "confidence": 0.0-1.0,
  "suggestion": "specific actionable fix with exact config/code reference",
  "affectedFields": ["field1"],
  "faultSource": "test_data_creation|migration|config|auth|unknown",
  "faultEvidence": "detailed evidence citing specific log lines and timestamps",
  "logProof": [
    { "timestamp": "ISO timestamp", "logLine": "exact log line", "explains": "which mismatch this explains" }
  ],
  "firstFailureAt": "ISO timestamp of earliest log evidence of the failure"
}`;

    try {
      const raw = await chat(prompt, 2000);
      const parsed = JSON.parse(raw);

      if (parsed.faultSource === 'unknown' && preClassified) {
        parsed.faultSource = preClassified;
        parsed.faultEvidence = `${parsed.faultEvidence || ''} (count-threshold override)`.trim();
      }

      return {
        ...parsed,
        mismatches: mismatchSummary.length,
        localLogAvailable: execLog.available,
        grafanaAvailable: grafanaResult.available,
        grafanaReason: grafanaResult.available ? null : grafanaResult.reason,
      };
    } catch (err) {
      // Fall back to standard analysis if log-backed analysis fails
      const fallback = await this.analyzeFailure(validationResult, context);
      return {
        ...fallback,
        localLogAvailable: execLog.available,
        grafanaAvailable: grafanaResult.available,
        grafanaReason: grafanaResult.available ? null : grafanaResult.reason,
        logProof: [],
        firstFailureAt: null,
        _fallback: true,
      };
    }
  }

  /**
   * Generates test cases based on migration context and historical results.
   */
  async generateTestCases(context) {
    try {
      const prompt = `Generate targeted email migration test cases for this context:

${JSON.stringify(context, null, 2)}

Return a JSON array of 5-10 test case objects. Each object must have:
{
  "name": "short test name",
  "description": "what this validates",
  "folder": "Inbox|Sent Items|Drafts|Junk Email|Deleted Items|Archive|<custom>",
  "subject": "email subject",
  "textBody": "plain text body (or omit for htmlBody)",
  "isRead": true|false,
  "importance": "normal|high|low" (optional),
  "flag": { "flagStatus": "flagged" } (optional),
  "categories": ["Red Category"] (optional),
  "attachments": [{ "name": "file.txt", "contentType": "text/plain", "content": "<base64>" }] (optional),
  "priority": "high|medium|low"
}

Focus on edge cases most likely to fail for this specific migration direction and user volume.`;

      const raw = await chat(prompt);
      return JSON.parse(raw);
    } catch (err) {
      return [
        {
          name: 'Default fallback test',
          description: err.message.includes('OPENAI_API_KEY') ? 'Set OPENAI_API_KEY to enable AI test generation' : `Generation failed: ${err.message}`,
          folder: 'Inbox',
          subject: 'QA Fallback - Migration Test',
          textBody: 'Fallback test email.',
          isRead: true,
          priority: 'medium',
        },
      ];
    }
  }

  /**
   * Suggests a fix for a specific validation mismatch.
   */
  async suggestFix(mismatch) {
    try {
      const prompt = `Suggest a specific fix for this migration validation mismatch:

${JSON.stringify(mismatch, null, 2)}

Respond with a JSON object:
{
  "suggestion": "one-sentence fix summary",
  "steps": ["step 1", "step 2", "..."],
  "confidence": 0.0-1.0,
  "severity": "critical|high|medium|low",
  "isAutoFixable": true|false,
  "fixTarget": "source|destination|mapping|config"
}`;

      const raw = await chat(prompt);
      const parsed = JSON.parse(raw);
      return { ...parsed };
    } catch (err) {
      return {
        suggestion: err.message.includes('OPENAI_API_KEY') ? 'Set OPENAI_API_KEY to enable AI fix suggestions' : `Suggestion failed: ${err.message}`,
        steps: [],
        confidence: 0,
        severity: 'unknown',
        isAutoFixable: false,
        fixTarget: 'unknown',
      };
    }
  }
}

module.exports = new AgentBrain();
