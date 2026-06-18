const orchestrator = require('../orchestrator/AgentOrchestrator');
const messageOrchestrator = require('../orchestrator/MessageAgentOrchestrator');
const executionService = require('../services/executionService');
const MigrationContext = require('../models/MigrationContext');
const MessageMigrationContext = require('../models/MessageMigrationContext');
const migrationClient = require('../clients/migrationClient');
const channelCache = require('../services/channelCache');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const logsDir = path.resolve(__dirname, '../../logs');

async function runAgents(req, res) {
  try {
    const {
      sourceEmail,
      destinationEmail,
      migrationType,
      includeMail,
      includeCalendar,
      testType,
      mappedPairs,
      productType,
      messageCombination,
      messageAdmins,
    } = req.body;

    // Bulk migration: multiple mapped pairs
    if (mappedPairs && Array.isArray(mappedPairs) && mappedPairs.length > 0) {
      const results = [];
      for (const pair of mappedPairs) {
        try {
          const result = await orchestrator.runFullFlow({
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
            migrationType: migrationType || 'FULL',
            includeMail: includeMail !== false,
            includeCalendar: includeCalendar !== false,
            testType: testType || 'E2E',
            productType: productType || 'Mail',
            messageCombination: messageCombination || 'Slack → Google Chat',
            messageAdmins: messageAdmins || undefined,
          });
          results.push(result);
        } catch (err) {
          results.push({
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
            status: 'FAILED',
            error: err.message,
          });
        }
      }
      return res.json({
        bulk: true,
        totalPairs: mappedPairs.length,
        completed: results.filter((r) => r.status === 'COMPLETED').length,
        failed: results.filter((r) => r.status === 'FAILED').length,
        results,
      });
    }

    // Single pair migration — return 202 immediately so the UI can poll execution progress
    // (MigrationAgent may run for many minutes polling Outlook).
    if (!sourceEmail || !destinationEmail) {
      return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
    }

    const context = new MigrationContext({
      sourceEmail,
      destinationEmail,
      migrationType: migrationType || 'FULL',
      includeMail: includeMail !== false,
      includeCalendar: includeCalendar !== false,
      testType: testType || 'E2E',
      productType: productType || 'Mail',
      messageCombination: messageCombination || 'Slack → Google Chat',
      messageAdmins: messageAdmins || undefined,
    });
    context.validate();

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: 'Starting',
      progress: 'Queued — full QA flow will start shortly',
    });

    res.status(202).json({
      executionId: context.executionId,
      status: 'RUNNING',
      message:
        'Execution started. Poll GET /api/agents/executions/:id or open Execution Logs to watch progress.',
      context: context.toJSON(),
    });

    setImmediate(() => {
      orchestrator.runFullFlow(context).catch((err) => {
        logger.error(`Background orchestration failed: ${err.message}`);
      });
    });
  } catch (err) {
    logger.error(`runAgents error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Message Agent — chat/message migration QA. Mirrors runAgents (mail) by spawning
 * the full orchestrator flow asynchronously and returning 202 so the UI can poll
 * /api/agents/executions/:id exactly like Run Agent does.
 */
async function runMessageAgent(req, res) {
  try {
    const {
      sourceEmail,
      destinationEmail,
      sourceAdminEmail,
      migrationType,
      testType,
      mappedPairs,
      messageCombination,
      channelIds,
      dmIds,
      selectedTestCaseIds,
    } = req.body;

    const normalizeIds = (v) => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
      if (typeof v === 'string') {
        return v
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return [];
    };
    const channelIdsNorm = normalizeIds(channelIds);
    const dmIdsNorm = normalizeIds(dmIds);

    const sharedOpts = {
      migrationType: migrationType || 'FULL',
      testType: testType || 'SANITY',
      messageCombination: messageCombination || null,
      channelIds: channelIdsNorm,
      dmIds: dmIdsNorm,
      selectedTestCaseIds: Array.isArray(selectedTestCaseIds)
        ? selectedTestCaseIds.map(String).filter(Boolean)
        : [],
      sourceAdminEmail: sourceAdminEmail || null,
    };

    // Bulk: multiple mapped pairs — run them sequentially and return the aggregate,
    // matching the shape the frontend bulk handler already understands.
    if (mappedPairs && Array.isArray(mappedPairs) && mappedPairs.length > 0) {
      const results = [];
      for (const pair of mappedPairs) {
        try {
          const ctx = new MessageMigrationContext({
            ...sharedOpts,
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
          });
          ctx.validate();
          executionService.create(ctx);
          const result = await messageOrchestrator.runFullFlow(ctx);
          results.push(result);
        } catch (err) {
          results.push({
            kind: 'message',
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
            status: 'FAILED',
            error: err.message,
          });
        }
      }
      return res.json({
        kind: 'message',
        bulk: true,
        totalPairs: mappedPairs.length,
        completed: results.filter((r) => r.status === 'COMPLETED').length,
        failed: results.filter((r) => r.status === 'FAILED').length,
        results,
      });
    }

    if (!sourceEmail || !destinationEmail) {
      return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
    }
    if (!sharedOpts.messageCombination) {
      return res.status(400).json({ error: 'messageCombination is required' });
    }

    const context = new MessageMigrationContext({
      ...sharedOpts,
      sourceEmail,
      destinationEmail,
    });
    context.validate();

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: 'Starting',
      progress: 'Queued — Message Agent flow will start shortly',
    });

    res.status(202).json({
      kind: 'message',
      executionId: context.executionId,
      status: 'RUNNING',
      message:
        'Message Agent execution started. Poll GET /api/agents/executions/:id or open Execution Logs to watch progress.',
      context: context.toJSON(),
    });

    setImmediate(() => {
      messageOrchestrator.runFullFlow(context).catch((err) => {
        logger.error(`Message orchestration failed: ${err.message}`);
      });
    });
  } catch (err) {
    logger.error(`runMessageAgent error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Helper — shared payload parsing for /message-seed and /message-migrate.
 * Mirrors what runMessageAgent does but returns the base options only.
 */
function parseMessagePayload(req) {
  const {
    sourceEmail,
    destinationEmail,
    sourceAdminEmail,
    migrationType,
    testType,
    mappedPairs,
    messageCombination,
    channelIds,
    dmIds,
    channelObjects,
    dmObjects,
    selectedTestCaseIds,
    repeatCount,
  } = req.body;

  const normalizeIds = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof v === 'string') {
      return v.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    }
    return [];
  };

  return {
    sourceEmail,
    destinationEmail,
    mappedPairs,
    sharedOpts: {
      migrationType: migrationType || 'FULL',
      testType: testType || 'SANITY',
      messageCombination: messageCombination || null,
      channelIds: normalizeIds(channelIds),
      dmIds: normalizeIds(dmIds),
      channelObjects: Array.isArray(channelObjects) ? channelObjects : [],
      dmObjects: Array.isArray(dmObjects) ? dmObjects : [],
      selectedTestCaseIds: Array.isArray(selectedTestCaseIds)
        ? selectedTestCaseIds.map(String).filter(Boolean)
        : [],
      sourceAdminEmail: sourceAdminEmail || null,
      repeatCount: Math.max(1, parseInt(repeatCount, 10) || 1),
    },
  };
}

// ── CloudFuze cloud / channel / DM / reports endpoints ──────────────────────────

/**
 * GET /api/agents/cf-cloud-accounts
 * Returns all cloud accounts connected to this CloudFuze subscriber.
 */
async function getCFCloudAccounts(req, res) {
  try {
    const accounts = await migrationClient.getCloudAccounts();
    res.json({ accounts });
  } catch (err) {
    logger.error(`getCFCloudAccounts error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-channels?srcCloudId=...&dstCloudId=...&channelType=public|private|all&combination=...
 * Returns channels from CloudFuze and saves them into the channel cache.
 */
async function getCFChannels(req, res) {
  try {
    const { srcCloudId, dstCloudId, channelType = 'public', combination = '' } = req.query;
    const channels = await migrationClient.getCloudChannels({ srcCloudId, dstCloudId, channelType });

    // Update the relevant slice of the cache (partial update — preserve the other two types)
    if (srcCloudId && dstCloudId) {
      const existing = channelCache.get(combination, srcCloudId, dstCloudId) || {};
      const update = {
        publicChannels:  existing.publicChannels  || [],
        privateChannels: existing.privateChannels || [],
        dms:             existing.dms             || [],
      };
      if (channelType === 'public')  update.publicChannels  = channels;
      if (channelType === 'private') update.privateChannels = channels;
      channelCache.set(combination, srcCloudId, dstCloudId, update);
    }

    res.json({ channels });
  } catch (err) {
    logger.error(`getCFChannels error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-dms?srcCloudId=...&dstCloudId=...&combination=...
 * Returns DMs from CloudFuze and saves them into the channel cache.
 */
async function getCFDMs(req, res) {
  try {
    const { srcCloudId, dstCloudId, combination = '' } = req.query;
    const dms = await migrationClient.getCloudDMs({ srcCloudId, dstCloudId });

    if (srcCloudId && dstCloudId) {
      const existing = channelCache.get(combination, srcCloudId, dstCloudId) || {};
      channelCache.set(combination, srcCloudId, dstCloudId, {
        publicChannels:  existing.publicChannels  || [],
        privateChannels: existing.privateChannels || [],
        dms,
      });
    }

    res.json({ dms });
  } catch (err) {
    logger.error(`getCFDMs error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-channels-all?srcCloudId=...&dstCloudId=...&combination=...
 * Fetches public channels, private channels, and DMs in parallel, saves all to cache,
 * and returns the full set in one response.
 */
async function getCFChannelsAll(req, res) {
  try {
    const { srcCloudId, dstCloudId, combination = '' } = req.query;
    if (!srcCloudId || !dstCloudId) {
      return res.status(400).json({ error: 'srcCloudId and dstCloudId are required' });
    }

    const [pubChannels, privChannels, dms] = await Promise.all([
      migrationClient.getCloudChannels({ srcCloudId, dstCloudId, channelType: 'public' }),
      migrationClient.getCloudChannels({ srcCloudId, dstCloudId, channelType: 'private' }),
      migrationClient.getCloudDMs({ srcCloudId, dstCloudId }),
    ]);

    const payload = { publicChannels: pubChannels, privateChannels: privChannels, dms };
    channelCache.set(combination, srcCloudId, dstCloudId, payload);

    const fetchedAt = new Date().toISOString();
    res.json({ ...payload, fetchedAt });
  } catch (err) {
    logger.error(`getCFChannelsAll error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-channels-cache?srcCloudId=...&dstCloudId=...&combination=...
 * Returns previously cached channels/DMs without hitting the CF API.
 * { cached: true, publicChannels, privateChannels, dms, fetchedAt } or { cached: false }
 */
function getCFChannelsCache(req, res) {
  try {
    const { srcCloudId, dstCloudId, combination = '' } = req.query;
    const cached = channelCache.get(combination, srcCloudId, dstCloudId);
    if (cached) {
      res.json({ cached: true, ...cached });
    } else {
      res.json({ cached: false, publicChannels: [], privateChannels: [], dms: [] });
    }
  } catch (err) {
    logger.error(`getCFChannelsCache error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-reports?combination=S2T&migrationStatus=All
 * Returns migration jobs from CloudFuze.
 */
async function getCFReports(req, res) {
  try {
    const { combination = '', migrationStatus = 'All' } = req.query;
    const jobs = await migrationClient.getMigrationReports({ combination, migrationStatus });
    res.json({ jobs });
  } catch (err) {
    logger.error(`getCFReports error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/agents/cf-close-migration
 * Body: { jobIds: string[], combination?: string }
 * Calls the CloudFuze API to close (archive) the specified migration jobs.
 */
async function closeCFChatJobs(req, res) {
  try {
    const { jobIds = [] } = req.body;
    if (!jobIds.length) return res.status(400).json({ error: 'jobIds array is required' });
    const result = await migrationClient.closeChatMigrationJobs(jobIds);
    res.json({ success: true, closed: jobIds.length, result });
  } catch (err) {
    const cfBody = err.response?.data;
    const detail = (typeof cfBody === 'string' ? cfBody : cfBody?.message || cfBody?.error || JSON.stringify(cfBody)) || err.message;
    logger.error(`closeCFChatJobs error: ${detail}`);
    res.status(500).json({ error: detail });
  }
}

/**
 * Converts a display combination string (e.g. "Slack → Microsoft Teams")
 * to the CF API combination code (e.g. "S2T").
 * Mirrors the logic in cfBrowserAutomation._deriveCombCode.
 */
function deriveCombCode(combination) {
  const str = (combination || '').toLowerCase();
  const parts = str.split(/→|->|\s+to\s+/);
  const src = (parts[0] || '').trim();
  const dst = (parts.length > 1 ? parts[1] : str).trim();
  function platformLetter(s) {
    if (s.includes('slack'))                             return 'S';
    if (s.includes('teams') || s.includes('microsoft')) return 'T';
    if (s.includes('chat')  || s.includes('google'))    return 'C';
    return null;
  }
  const s = platformLetter(src);
  const d = platformLetter(dst);
  if (s && d) {
    const code = `${s}2${d}`;
    const valid = ['S2T','S2C','S2S','T2T','T2C','T2S','C2T','C2C','C2S'];
    if (valid.includes(code)) return code;
  }
  const upper = str.toUpperCase().replace(/\s/g, '');
  const plain = ['S2T','S2C','S2S','T2T','T2C','T2S','C2T','C2C','C2S'].find(c => upper.includes(c));
  return plain || '';
}

/**
 * POST /api/agents/cf-validate-migration
 * Body: { combination?: string, migrationStatus?: string, sourceLabel?: string, destLabel?: string }
 *
 * Fetches all jobs from CloudFuze, closes any completed-but-open jobs (matching CF
 * "Close Teams" button behavior), builds a validation summary by comparing
 * totalMessages vs processedMessages for each job, stores the result as a new
 * execution (so it appears in Validation Results), and returns the executionId.
 */
async function validateCFChatMigration(req, res) {
  try {
    const {
      combination = '',
      migrationStatus = 'All',
      sourceLabel = '',
      destLabel = '',
    } = req.body;

    // Convert display string ("Slack → Microsoft Teams") → CF API code ("S2T")
    const comboCode = deriveCombCode(combination);

    const jobs = await migrationClient.getMigrationReports({ combination: comboCode, migrationStatus });

    // Auto-close completed jobs (mirrors the "Close Teams" button in CF Reports).
    // This is required before validation so the team status transitions from "Open" to "Closed".
    const completedIds = jobs
      .filter(j => (j.migrationStatus || '').toLowerCase() === 'completed')
      .map(j => j.id)
      .filter(Boolean);
    if (completedIds.length > 0) {
      try {
        await migrationClient.closeChatMigrationJobs(completedIds);
        logger.info(`validateCFChatMigration: closed ${completedIds.length} completed job(s)`);
      } catch (closeErr) {
        logger.warn(`validateCFChatMigration: close jobs error (non-fatal): ${closeErr.message}`);
      }
    }

    const channelDetails = [];
    const mismatches = [];

    for (const job of jobs) {
      const total     = Number(job.totalMessages)     || 0;
      const processed = Number(job.processedMessages) || 0;
      const inProg    = Number(job.inProgressMessages) || 0;
      const status    = (job.migrationStatus || '').toLowerCase();
      const isCompleted = status === 'completed';
      const match = isCompleted && total === processed;

      channelDetails.push({
        name:             job.teamName || String(job.id || ''),
        totalChannels:    Number(job.totalChannels) || 0,
        totalMessages:    total,
        processedMessages: processed,
        inProgressMessages: inProg,
        migrationStatus:  job.migrationStatus || '',
        teamStatus:       job.teamStatus || '',
        initiatedOn:      job.initiatedOn || '',
        match,
      });

      if (!match) {
        mismatches.push({
          category: 'Message Count',
          field: job.teamName || String(job.id || ''),
          expected: total,
          actual: processed,
          migrationStatus: job.migrationStatus || '',
        });
      }
    }

    const totalJobs     = jobs.length;
    const completedJobs = channelDetails.filter(j => j.migrationStatus.toLowerCase() === 'completed').length;
    const partialJobs   = channelDetails.filter(j => j.migrationStatus.toLowerCase().includes('partial')).length;
    const inProgressJobs = channelDetails.filter(j => j.migrationStatus.toLowerCase().includes('progress')).length;
    const totalMessages   = channelDetails.reduce((s, j) => s + j.totalMessages, 0);
    const processedMessages = channelDetails.reduce((s, j) => s + j.processedMessages, 0);

    const overallStatus = mismatches.length === 0 ? 'MATCHED' : 'MISMATCH';

    const executionId = `msg-val-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();

    try {
      executionService.createRaw({
        executionId,
        kind: 'message-validation',
        context: {
          kind: 'message-validation',
          combination: comboCode,
          sourceLabel: sourceLabel || comboCode.split('2')[0] || 'Source',
          destLabel:   destLabel   || comboCode.split('2')[1] || 'Destination',
          validatedAt: now,
        },
        status: 'COMPLETED',
        currentAgent: null,
        error: null,
        createdAt: now,
        completedAt: now,
        result: {
          validationSummary: {
            overallStatus,
            kind: 'message',
            combination: comboCode,
            mismatches,
            messageValidation: {
              totalJobs,
              completedJobs,
              partialJobs,
              inProgressJobs,
              totalMessages,
              processedMessages,
              matchRate: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
              channelDetails,
            },
          },
        },
      });
    } catch (saveErr) {
      logger.error(`validateCFChatMigration: failed to save execution: ${saveErr.message}`);
    }

    res.json({
      executionId,
      overallStatus,
      summary: { totalJobs, completedJobs, partialJobs, inProgressJobs, totalMessages, processedMessages, mismatches: mismatches.length },
    });
  } catch (err) {
    const cfBody = err.response?.data;
    const detail = (typeof cfBody === 'string' ? cfBody : cfBody?.message || cfBody?.error || JSON.stringify(cfBody)) || err.message;
    logger.error(`validateCFChatMigration error: ${detail}`);
    res.status(500).json({ error: detail });
  }
}

/**
 * Stage 1 — post Agent Repo test cases into source channels / DMs.
 * Runs MessageTestDataAgent only. Supports single pair or bulk mappedPairs.
 */
async function seedMessageAgent(req, res) {
  try {
    const { sourceEmail, destinationEmail, mappedPairs, sharedOpts } = parseMessagePayload(req);

    if (!sharedOpts.messageCombination) {
      return res.status(400).json({ error: 'messageCombination is required' });
    }
    if ((sharedOpts.channelIds.length + sharedOpts.dmIds.length) === 0) {
      return res.status(400).json({ error: 'At least one Channel ID or DM ID is required to seed' });
    }

    if (mappedPairs && Array.isArray(mappedPairs) && mappedPairs.length > 0) {
      const results = [];
      for (const pair of mappedPairs) {
        try {
          const ctx = new MessageMigrationContext({
            ...sharedOpts,
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
          });
          ctx.validate();
          executionService.create(ctx);
          const result = await messageOrchestrator.runSeedOnly(ctx);
          results.push(result);
        } catch (err) {
          results.push({
            kind: 'message',
            phase: 'seed',
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
            status: 'FAILED',
            error: err.message,
          });
        }
      }
      return res.json({
        kind: 'message',
        phase: 'seed',
        bulk: true,
        totalPairs: mappedPairs.length,
        completed: results.filter((r) => r.status === 'COMPLETED').length,
        failed: results.filter((r) => r.status === 'FAILED').length,
        results,
      });
    }

    if (!sourceEmail || !destinationEmail) {
      return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
    }

    const context = new MessageMigrationContext({
      ...sharedOpts,
      sourceEmail,
      destinationEmail,
    });
    context.validate();

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: 'Starting',
      progress: 'Queued — seeding will start shortly',
    });

    res.status(202).json({
      kind: 'message',
      phase: 'seed',
      executionId: context.executionId,
      status: 'RUNNING',
      message: 'Seeding started. Poll GET /api/agents/executions/:id to watch progress.',
      context: context.toJSON(),
    });

    setImmediate(() => {
      messageOrchestrator.runSeedOnly(context).catch((err) => {
        logger.error(`Message seed failed: ${err.message}`);
      });
    });
  } catch (err) {
    logger.error(`seedMessageAgent error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * Stage 2 — run Migration + Validation on the user-selected subset of
 * already-seeded channels / DMs.
 */
async function migrateMessageAgent(req, res) {
  try {
    const { sourceEmail, destinationEmail, mappedPairs, sharedOpts } = parseMessagePayload(req);

    if (!sharedOpts.messageCombination) {
      return res.status(400).json({ error: 'messageCombination is required' });
    }
    if ((sharedOpts.channelIds.length + sharedOpts.dmIds.length) === 0) {
      return res.status(400).json({
        error:
          'Select at least one posted Channel ID or DM ID to migrate. Run the seed step first, then pick targets.',
      });
    }

    if (mappedPairs && Array.isArray(mappedPairs) && mappedPairs.length > 0) {
      const results = [];
      for (const pair of mappedPairs) {
        try {
          const ctx = new MessageMigrationContext({
            ...sharedOpts,
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
          });
          ctx.validate();
          executionService.create(ctx);
          const result = await messageOrchestrator.runMigrateOnly(ctx);
          results.push(result);
        } catch (err) {
          results.push({
            kind: 'message',
            phase: 'migrate',
            sourceEmail: pair.sourceEmail,
            destinationEmail: pair.destinationEmail,
            status: 'FAILED',
            error: err.message,
          });
        }
      }
      return res.json({
        kind: 'message',
        phase: 'migrate',
        bulk: true,
        totalPairs: mappedPairs.length,
        completed: results.filter((r) => r.status === 'COMPLETED').length,
        failed: results.filter((r) => r.status === 'FAILED').length,
        results,
      });
    }

    if (!sourceEmail || !destinationEmail) {
      return res.status(400).json({ error: 'sourceEmail and destinationEmail are required' });
    }

    const context = new MessageMigrationContext({
      ...sharedOpts,
      sourceEmail,
      destinationEmail,
    });
    context.validate();

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: 'Starting',
      progress: 'Queued — migration will start shortly',
    });

    res.status(202).json({
      kind: 'message',
      phase: 'migrate',
      executionId: context.executionId,
      status: 'RUNNING',
      message: 'Migration started. Poll GET /api/agents/executions/:id to watch progress.',
      context: context.toJSON(),
    });

    setImmediate(() => {
      messageOrchestrator.runMigrateOnly(context).catch((err) => {
        logger.error(`Message migrate failed: ${err.message}`);
      });
    });
  } catch (err) {
    logger.error(`migrateMessageAgent error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/agents/upload-mapping-csv
 * Body: { filename?: string, content: string }   (content = raw CSV text)
 * Saves the CSV to a server temp file and returns the absolute path.
 * The path is then passed back in the CF-browser-migrate payload as userMappingCsvPath
 * so Playwright can upload the exact file to the CloudFuze UI.
 */
async function uploadMappingCsv(req, res) {
  try {
    const { content, filename } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content (CSV text) is required' });
    }

    const os = require('os');
    const safe = (filename || 'mapping').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const filePath = path.join(os.tmpdir(), `cf_user_mapping_${Date.now()}_${safe}`);
    fs.writeFileSync(filePath, content, 'utf8');

    logger.info(`[uploadMappingCsv] Saved ${content.split('\n').length - 1} row(s) to ${filePath}`);
    res.json({ filePath, rows: content.split('\n').filter(Boolean).length - 1 });
  } catch (err) {
    logger.error(`uploadMappingCsv error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function getExecutions(_req, res) {
  const executions = executionService.getAll();
  res.json(executions);
}

function getExecution(req, res) {
  const execution = executionService.get(req.params.id);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }
  res.json(execution);
}

function getExecutionLogs(req, res) {
  const executionId = req.params.id;
  const logFile = path.join(logsDir, `${executionId}.log`);

  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { message: line };
        }
      });
      res.json({ executionId, logs: lines });
    } else {
      res.json({ executionId, logs: [] });
    }
  } catch (err) {
    res.status(500).json({ error: `Failed to read logs: ${err.message}` });
  }
}

function getStats(_req, res) {
  res.json(executionService.getStats());
}

async function testConnections(req, res) {
  const results = { gmail: null, outlook: null, migration: null };

  // Test all Gmail accounts
  try {
    const { google } = require('googleapis');
    const env = require('../config/env');
    const accounts = [];
    for (const [email, token] of env.googleAccounts) {
      try {
        const oauth2Client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
        oauth2Client.setCredentials({ refresh_token: token });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        accounts.push({ email, status: 'OK', authenticatedAs: profile.data.emailAddress });
      } catch (err) {
        accounts.push({ email, status: 'FAILED', error: err.message });
      }
    }
    results.gmail = { status: accounts.every((a) => a.status === 'OK') ? 'OK' : 'PARTIAL', accounts };
  } catch (err) {
    results.gmail = { status: 'FAILED', error: err.message };
  }

  // Test Microsoft Graph API
  try {
    const { ConfidentialClientApplication } = require('@azure/msal-node');
    const env = require('../config/env');
    const cca = new ConfidentialClientApplication({
      auth: {
        clientId: env.GRAPH_CLIENT_ID,
        clientSecret: env.GRAPH_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}`,
      },
    });
    const tokenResult = await cca.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });
    results.outlook = { status: 'OK', tokenLength: tokenResult.accessToken.length };
  } catch (err) {
    results.outlook = { status: 'FAILED', error: err.message };
  }

  // Test Migration API
  try {
    const axios = require('axios');
    const env = require('../config/env');
    const { migrationAxiosConfig } = require('../clients/migrationClient');
    const resp = await axios.get(
      env.MIGRATION_API_URL,
      migrationAxiosConfig({
        timeout: 10000,
        validateStatus: () => true,
      })
    );
    results.migration = { status: 'OK', httpStatus: resp.status };
  } catch (err) {
    results.migration = { status: 'FAILED', error: err.message };
  }

  res.json(results);
}

function loadUsersConfig() {
  const usersFile = path.resolve(__dirname, '../../data/users.json');
  try {
    const raw = fs.readFileSync(usersFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { source: { admins: [] }, destination: { admins: [] } };
  }
}

async function getSourceUsers(req, res) {
  try {
    const { adminEmail, provider } = req.query;
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail query param is required' });

    const config = loadUsersConfig();
    const admin = config.source?.admins?.find(
      (a) => a.email.toLowerCase() === adminEmail.toLowerCase()
    );

    if (admin && admin.users?.length > 0) {
      const users = admin.users.map((u) => ({
        id: u.email,
        email: u.email,
        displayName: `${u.firstName} ${u.lastName}`.trim(),
        firstName: u.firstName,
        lastName: u.lastName || '',
      }));
      return res.json({ adminEmail, users, source: 'config' });
    }

    // Route by provider
    if (provider === 'microsoft') {
      const outlookClient = require('../clients/outlookClient');
      logger.info(`getSourceUsers: fetching Microsoft tenant users (admin: ${adminEmail})`);
      const allUsers = await outlookClient.listUsers(adminEmail);
      const domain = adminEmail.split('@')[1]?.toLowerCase();
      const users = domain
        ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain)
        : allUsers;
      return res.json({ adminEmail, users, source: 'graph' });
    }

    if (provider === 'slack') {
      const slackClient = require('../clients/slackClient');
      logger.info(`getSourceUsers: fetching Slack workspace users (admin: ${adminEmail})`);
      const users = await slackClient.listWorkspaceUsers(adminEmail);
      return res.json({ adminEmail, users, total: users.length, source: 'slack' });
    }

    // Default: Google Workspace
    const gmailClient = require('../clients/gmailClient');
    const users = await gmailClient.listDomainUsers(adminEmail);
    res.json({ adminEmail, users, source: 'gmail' });
  } catch (err) {
    logger.error(`getSourceUsers error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function getDestinationUsers(req, res) {
  try {
    const { adminEmail, provider } = req.query;

    const config = loadUsersConfig();
    const admin = config.destination?.admins?.find(
      (a) => a.email.toLowerCase() === (adminEmail || '').toLowerCase()
    );

    if (admin && admin.users?.length > 0) {
      const users = admin.users.map((u) => ({
        id: u.email,
        email: u.email,
        displayName: `${u.firstName} ${u.lastName}`.trim(),
        firstName: u.firstName || '',
        lastName: u.lastName || '',
      }));
      logger.info(`getDestinationUsers: using config list (${users.length} users) for admin ${adminEmail}`);
      return res.json({ adminEmail, users, total: users.length });
    }

    // Route by provider
    if (provider === 'google') {
      const gmailClient = require('../clients/gmailClient');
      logger.info(`getDestinationUsers: fetching Google Workspace users (admin: ${adminEmail})`);
      const users = await gmailClient.listDomainUsers(adminEmail);
      return res.json({ adminEmail, users, total: users.length, source: 'gmail' });
    }

    if (provider === 'slack') {
      if (!adminEmail) return res.status(400).json({ error: 'adminEmail query param is required for Slack' });
      const slackClient = require('../clients/slackClient');
      logger.info(`getDestinationUsers: fetching Slack workspace users (admin: ${adminEmail})`);
      const users = await slackClient.listWorkspaceUsers(adminEmail);
      return res.json({ adminEmail, users, total: users.length, source: 'slack' });
    }

    // Default: Microsoft 365 via Graph API
    const outlookClient = require('../clients/outlookClient');
    logger.info(`getDestinationUsers: fetching Microsoft tenant users via Graph API (admin: ${adminEmail || 'none'})`);
    const allTenantUsers = await outlookClient.listUsers(adminEmail);
    const domain = adminEmail ? adminEmail.split('@')[1]?.toLowerCase() : null;
    const users = domain
      ? allTenantUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain)
      : allTenantUsers;
    logger.info(`getDestinationUsers: ${users.length} users found${domain ? ` (@${domain})` : ''}`);

    res.json({ adminEmail, users, total: users.length, source: 'graph' });
  } catch (err) {
    logger.error(`getDestinationUsers error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function getMailboxStats(req, res) {
  try {
    const { email, includeCalendar } = req.query;
    if (!email) return res.status(400).json({ error: 'email query param is required' });

    const outlookClient = require('../clients/outlookClient');

    const [folders, totalMessages] = await Promise.all([
      outlookClient.getMailFolders(email),
      outlookClient.getTotalMessageCount(email),
    ]);
    const defaults = outlookClient.DEFAULT_FOLDER_NAMES;

    let customFolderCount = 0;
    for (const f of folders) {
      if (!defaults.has(f.displayName)) customFolderCount++;
      if (f.childFolders?.length > 0) {
        for (const child of f.childFolders) {
          if (!defaults.has(child.displayName)) customFolderCount++;
        }
      }
    }

    const result = { email, mailCount: totalMessages, folderCount: customFolderCount, calendarCount: 0, eventCount: 0 };

    if (includeCalendar === 'true') {
      try {
        const calendars = await outlookClient.getCalendars(email);
        result.calendarCount = calendars.length;
        for (const cal of calendars) {
          // Skip system/read-only calendars that cleanMailbox cannot delete
          if (cal.name === 'Birthdays' || cal.name.toLowerCase().includes('holidays') || cal.canEdit === false) continue;
          const evtCount = await outlookClient.getEventCount(email, cal.id);
          result.eventCount += evtCount;
        }
      } catch { /* Calendar access may not be available */ }
    }

    res.json(result);
  } catch (err) {
    const graphBody = err.response?.data;
    const detail = graphBody ? ` ${JSON.stringify(graphBody)}` : '';
    logger.error(`getMailboxStats error for ${req.query.email}: ${err.message}${detail}`);
    res.status(500).json({ error: err.message, graphError: graphBody || undefined });
  }
}

async function cleanDestination(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Increase timeout for large mailboxes
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    logger.info(`Cleaning destination mailbox: ${email}`);
    const outlookClient = require('../clients/outlookClient');

    const before = await outlookClient.getMailFolders(email);
    const beforeMsgs = before.reduce((sum, f) => {
      let count = f.totalItemCount || 0;
      if (f.childFolders) count += f.childFolders.reduce((s, c) => s + (c.totalItemCount || 0), 0);
      return sum + count;
    }, 0);

    const summary = await outlookClient.cleanMailbox(email);

    const after = await outlookClient.getMailFolders(email);
    const afterMsgs = after.reduce((sum, f) => {
      let count = f.totalItemCount || 0;
      if (f.childFolders) count += f.childFolders.reduce((s, c) => s + (c.totalItemCount || 0), 0);
      return sum + count;
    }, 0);

    logger.info(`Cleaned ${email}: ${summary.messagesDeleted} msgs, ${summary.foldersDeleted} folders, ${summary.eventsDeleted} events, ${summary.calendarsDeleted} calendars`);

    res.json({
      email,
      before: { folders: before.length, messages: beforeMsgs },
      after: { folders: after.length, messages: afterMsgs },
      deleted: summary,
    });
  } catch (err) {
    logger.error(`cleanDestination error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

function generatePdf(req, res) {
  try {
    const execution = executionService.get(req.params.id);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    if (!execution.result) return res.status(400).json({ error: 'Execution has no results yet' });

    const { generateValidationPdf, generateMessageValidationPdf } = require('../utils/pdfGenerator');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="validation-report-${req.params.id.slice(0, 8)}.pdf"`);

    // Message/chat migration executions get their own PDF layout
    const isMessageExecution = execution.result?.kind === 'message' || execution.context?.kind === 'message';
    if (isMessageExecution) {
      generateMessageValidationPdf(execution, res);
    } else {
      generateValidationPdf(execution, res);
    }
  } catch (err) {
    logger.error(`generatePdf error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}


async function getSourceMailboxStats(req, res) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email query param is required' });
    const envCheck = require('../config/env');
    if (!envCheck.googleAccounts.has(email.toLowerCase())) {
      return res.json({ email, mailCount: 0, folderCount: 0, calendarCount: 0, eventCount: 0, noToken: true });
    }
    const gmailClient = require('../clients/gmailClient');
    const stats = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, ...stats });
  } catch (err) {
    require('../utils/logger').error('getSourceMailboxStats error: ' + err.message);
    // Return graceful 200 so the UI can show a helpful message instead of just "error"
    res.json({ email: req.query.email, mailCount: 0, folderCount: 0, calendarCount: 0, eventCount: 0, tokenError: true, tokenErrorMsg: err.message });
  }
}

async function cleanSource(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    require('../utils/logger').info('Cleaning source Gmail: ' + email);
    const gmailClient = require('../clients/gmailClient');
    const summary = await gmailClient.cleanGmailMailbox(email);
    const after = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, deleted: summary, after: after });
  } catch (err) {
    require('../utils/logger').error('cleanSource error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function getCalendarEventCount(req, res) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const axios = require('axios');
    const env = require('../config/env');
    const base = env.BULK_CALENDAR_API_URL;
    const { data } = await axios.get(`${base}/bulk/calendar/event-count`, {
      params: { userEmail: email, olderThanDays: 0 },
      timeout: 30000,
    });
    res.json(data);
  } catch (err) {
    logger.error(`getCalendarEventCount error for ${req.query.email}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function deleteCalendarEvents(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const axios = require('axios');
    const env = require('../config/env');
    const base = env.BULK_CALENDAR_API_URL;
    logger.info(`[deleteCalendarEvents] Deleting primary calendar events for ${email}`);
    const { data } = await axios.post(
      `${base}/bulk/calendar/delete-all-events`,
      null,
      { params: { userEmail: email }, timeout: 0 },
    );
    logger.info(`[deleteCalendarEvents] ${email}: deleted ${data.deletedCount ?? 0} events`);
    res.json(data);
  } catch (err) {
    logger.error(`deleteCalendarEvents error for ${req.body?.email}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /source-calendar-stats?email=...
 * Dry-run primary + secondary Google Calendar delete to get event counts from bulk API.
 */
async function getSourceCalendarStats(req, res) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const axios = require('axios');
    const env = require('../config/env');
    const base = env.BULK_CALENDAR_API_URL;
    const [primaryRes, secondaryRes] = await Promise.allSettled([
      axios.post(`${base}/calendar/delete-primary`, null, {
        params: { userEmail: email, dryRun: true },
        timeout: 30000,
      }),
      axios.post(`${base}/calendar/delete-secondary`, null, {
        params: { userEmail: email, dryRun: true },
        timeout: 30000,
      }),
    ]);
    const primaryData = primaryRes.status === 'fulfilled' ? primaryRes.value.data : null;
    const secondaryData = secondaryRes.status === 'fulfilled' ? secondaryRes.value.data : null;
    const primaryCount = primaryData?.totalEventsFound ?? 0;
    const secondaryCount = secondaryData?.totalEventsFound ?? 0;
    res.json({
      email,
      primaryEventCount: primaryCount,
      secondaryEventCount: secondaryCount,
      eventCount: primaryCount + secondaryCount,
    });
  } catch (err) {
    logger.error(`getSourceCalendarStats error for ${req.query.email}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /delete-source-calendar-events  { email }
 * Delete all events from primary + secondary Google Calendars via bulk API.
 */
async function deleteSourceCalendarEvents(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const axios = require('axios');
    const env = require('../config/env');
    const base = env.BULK_CALENDAR_API_URL;
    logger.info(`[deleteSourceCalendarEvents] Deleting all calendar events for ${email}`);
    const { data } = await axios.post(
      `${base}/calendar/delete-all`,
      null,
      { params: { userEmail: email, confirm: true, dryRun: false }, timeout: 0 },
    );
    logger.info(`[deleteSourceCalendarEvents] ${email}: deleted ${data.deleted ?? 0} events`);
    res.json(data);
  } catch (err) {
    logger.error(`deleteSourceCalendarEvents error for ${req.body?.email}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/message-targets?provider=slack|microsoft|google&adminEmail=...
 *
 * Returns public/private channels, 1:1 DMs, and group DMs visible to the given
 * admin on the given platform. Used by the Message Agent UI so users can pick
 * targets by name instead of pasting IDs.
 */
async function getMessageTargets(req, res) {
  try {
    const provider = String(req.query.provider || '').toLowerCase();
    const adminEmail = String(req.query.adminEmail || '').trim();
    if (!provider) return res.status(400).json({ error: 'provider query param is required (slack|microsoft|google)' });
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail query param is required' });

    if (provider === 'slack') {
      const slackClient = require('../clients/slackClient');
      const out = await slackClient.listConversations(adminEmail);
      return res.json({ provider, adminEmail, ...out });
    }
    if (provider === 'microsoft' || provider === 'teams') {
      const outlookClient = require('../clients/outlookClient');
      const out = await outlookClient.listTeamsTargets(adminEmail);
      return res.json({ provider: 'microsoft', adminEmail, ...out });
    }
    if (provider === 'google' || provider === 'chat') {
      const googleChatClient = require('../clients/googleChatClient');
      const out = await googleChatClient.listSpaces(adminEmail);
      return res.json({ provider: 'google', adminEmail, ...out });
    }
    return res.status(400).json({ error: `Unsupported provider "${provider}". Use slack | microsoft | google.` });
  } catch (err) {
    logger.error(`getMessageTargets error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/debug-google-chat?adminEmail=...
 * Diagnoses Google Chat API connectivity: checks token, scopes, and makes
 * a direct test call to chat.googleapis.com to surface the exact error.
 */
async function debugGoogleChat(req, res) {
  const adminEmail = String(req.query.adminEmail || '').trim();
  if (!adminEmail) return res.status(400).json({ error: 'adminEmail is required' });

  const tokenStore = require('../clients/oauthTokenStore');
  const { google } = require('googleapis');
  const axios = require('axios');
  const env = require('../config/env');

  const stored = tokenStore.getGoogleToken(adminEmail);
  if (!stored?.refreshToken) {
    return res.json({
      ok: false,
      step: 'token_lookup',
      error: `No Google token stored for ${adminEmail}. Sign in via Message Agent Step 1 → Google tab.`,
      agent: null,
    });
  }

  const agentTag = stored.agent || 'NOT SET (defaults to mail — re-authenticate via Message Agent)';

  // Get access token
  let accessToken;
  try {
    const domain = adminEmail.split('@')[1]?.toLowerCase() || '';
    let tenant = '1';
    if (env.GOOGLE_CLIENT_ID_2 && (env.GOOGLE_TENANT_2_DOMAINS || []).includes(domain)) tenant = '2';
    if (env.GOOGLE_CLIENT_ID_3 && (env.GOOGLE_TENANT_3_DOMAINS || []).includes(domain)) tenant = '3';
    if (env.GOOGLE_CLIENT_ID_4 && (env.GOOGLE_TENANT_4_DOMAINS || []).includes(domain)) tenant = '4';

    const creds = {
      '1': { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET },
      '2': { id: env.GOOGLE_CLIENT_ID_2, secret: env.GOOGLE_CLIENT_SECRET_2 },
      '3': { id: env.GOOGLE_CLIENT_ID_3, secret: env.GOOGLE_CLIENT_SECRET_3 },
      '4': { id: env.GOOGLE_CLIENT_ID_4, secret: env.GOOGLE_CLIENT_SECRET_4 },
    }[tenant];

    const oauth2 = new google.auth.OAuth2(creds.id, creds.secret);
    oauth2.setCredentials({ refresh_token: stored.refreshToken });
    const { token } = await oauth2.getAccessToken();
    accessToken = token;
  } catch (err) {
    return res.json({ ok: false, step: 'token_refresh', agentTag, error: err.message });
  }

  // Check what scopes the token actually has
  let tokenInfo;
  try {
    const r = await axios.get(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`);
    tokenInfo = r.data;
  } catch (err) {
    tokenInfo = { error: err.message };
  }

  const grantedScopes = (tokenInfo.scope || '').split(' ');
  const hasChatScope = grantedScopes.some(s => s.includes('chat'));

  // Try calling Chat API
  let chatResult;
  try {
    const r = await axios.get('https://chat.googleapis.com/v1/spaces', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { pageSize: 5 },
    });
    chatResult = { ok: true, spacesFound: (r.data.spaces || []).length, sample: (r.data.spaces || []).slice(0, 3).map(s => ({ name: s.name, displayName: s.displayName, spaceType: s.spaceType })) };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.error?.message || err.message;
    chatResult = { ok: false, httpStatus: status, error: msg, rawResponse: err.response?.data };
  }

  res.json({
    adminEmail,
    agentTag,
    hasChatScope,
    grantedScopes: grantedScopes.filter(s => s.includes('chat') || s.includes('googleapis')),
    chatApiResult: chatResult,
    diagnosis: !hasChatScope
      ? '❌ Token has NO chat scopes. Sign out and re-authenticate via Message Agent Step 1 → Google tab.'
      : chatResult.ok
      ? '✅ Google Chat API working correctly.'
      : chatResult.httpStatus === 403
      ? '❌ 403 Forbidden — chat scopes present but Google rejected the call. Check OAuth consent screen scopes match and re-authenticate.'
      : chatResult.error?.includes('app not found') || chatResult.error?.includes('Chat App')
      ? '❌ Chat App not configured. Go to Google Cloud Console → Google Chat API → Configuration tab → fill App Name → Save.'
      : `❌ ${chatResult.error}`,
  });
}

/**
 * GET /api/agents/message-user-status?emails=a@b.com,c@d.com&platform=microsoft
 * Returns token-ready status for each email so the UI can show which source users
 * still need to sign in before "Post Test Data" can run live.
 */
async function getMessageUserStatus(req, res) {
  const emailsRaw = String(req.query.emails || '').split(',').map(e => e.trim()).filter(Boolean);
  const platform = String(req.query.platform || '').toLowerCase();
  if (!emailsRaw.length) return res.status(400).json({ error: 'emails is required' });
  if (!platform) return res.status(400).json({ error: 'platform is required (microsoft|slack|google)' });

  const outlookClient = require('../clients/outlookClient');
  const slackClient = require('../clients/slackClient');
  const googleChatClient = require('../clients/googleChatClient');

  const statuses = emailsRaw.map(email => {
    let hasToken = false;
    if (platform === 'microsoft' || platform === 'teams') {
      hasToken = outlookClient.hasTeamsToken(email);
    } else if (platform === 'slack') {
      hasToken = slackClient.hasSlackToken(email);
    } else if (platform === 'google' || platform === 'googlechat') {
      hasToken = googleChatClient.hasGoogleChatToken(email);
    }
    return { email, hasToken };
  });

  return res.json({
    platform,
    ready: statuses.filter(s => s.hasToken).length,
    total: statuses.length,
    statuses,
  });
}

/**
 * GET /api/agents/debug-teams?adminEmail=...
 * Diagnoses Microsoft Teams API connectivity for the Message Agent:
 *   - checks stored token, agent tag, and decoded JWT scopes
 *   - attempts GET /me/joinedTeams and GET /me/chats
 *   - surfaces the exact error so you know whether to re-auth or grant consent
 */
async function debugTeams(req, res) {
  const adminEmail = String(req.query.adminEmail || '').trim();
  if (!adminEmail) return res.status(400).json({ error: 'adminEmail is required' });

  const tokenStore = require('../clients/oauthTokenStore');
  const outlookClient = require('../clients/outlookClient');
  const axios = require('axios');
  const env = require('../config/env');

  const stored = tokenStore.getMicrosoftToken(adminEmail);
  if (!stored?.accessToken && !stored?.refreshToken) {
    return res.json({
      ok: false,
      step: 'token_lookup',
      adminEmail,
      error: `No Microsoft token stored for ${adminEmail}. Sign in via Message Agent Step 1 → Microsoft tab.`,
    });
  }

  const agentTag = stored.agent || 'NOT SET (defaults to mail — re-authenticate via Message Agent)';
  const mode = stored.mode || 'delegated';

  // Decode JWT scopes from stored access token
  let jwtScopes = [];
  let issuingAppId = null;
  if (stored.accessToken) {
    try {
      const payload = JSON.parse(Buffer.from(stored.accessToken.split('.')[1], 'base64').toString());
      jwtScopes = (payload.scp || payload.scope || '').split(' ').filter(Boolean);
      issuingAppId = payload.appid || payload.azp || null;
    } catch { /* ignore */ }
  }

  const hasTeamsScope = jwtScopes.some(s =>
    s.toLowerCase().includes('team') || s.toLowerCase().includes('channel') || s.toLowerCase().includes('chat')
  );
  const hasTeamsToken = outlookClient.hasTeamsToken(adminEmail);

  // Get a fresh access token (this will refresh if needed)
  let accessToken;
  let tokenError = null;
  try {
    accessToken = await outlookClient.getAccessToken ? null : null; // not exported; use the stored one
    // Use stored (may be stale) for diagnosis — we check jwt decode above
    accessToken = stored.accessToken;
  } catch (err) {
    tokenError = err.message;
  }

  // Try GET /me/joinedTeams
  let teamsResult;
  try {
    const r = await axios.get('https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id,displayName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    teamsResult = { ok: true, teamsFound: (r.data.value || []).length, sample: (r.data.value || []).slice(0, 3).map(t => ({ id: t.id, name: t.displayName })) };
  } catch (err) {
    teamsResult = { ok: false, httpStatus: err.response?.status, error: err.response?.data?.error?.message || err.message };
  }

  // Try GET /me/chats
  let chatsResult;
  try {
    const r = await axios.get('https://graph.microsoft.com/v1.0/me/chats?$top=5', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    chatsResult = { ok: true, chatsFound: (r.data.value || []).length };
  } catch (err) {
    chatsResult = { ok: false, httpStatus: err.response?.status, error: err.response?.data?.error?.message || err.message };
  }

  const issuingAppLabel = issuingAppId === env.MS_MESSAGE_CLIENT_ID
    ? 'Message Agent app (Teams scopes)'
    : issuingAppId === env.GRAPH_CLIENT_ID
    ? 'Run Agent app (mail scopes)'
    : issuingAppId || 'unknown';

  let diagnosis;
  if (mode === 'app-only') {
    diagnosis = '⚠️ App-only token — cannot post as user. Sign in via Message Agent Step 1 → Microsoft tab (delegated OAuth).';
  } else if (!hasTeamsScope) {
    diagnosis = `❌ Token has NO Teams scopes (issued by: ${issuingAppLabel}). ` +
      `Sign out ${adminEmail} and re-authenticate via Message Agent Step 1 → Microsoft tab using the Teams app.`;
  } else if (teamsResult.ok && chatsResult.ok) {
    diagnosis = '✅ Teams API working correctly. Token has Teams scopes and Graph calls succeeded.';
  } else if (teamsResult.httpStatus === 403 || chatsResult.httpStatus === 403) {
    diagnosis = `❌ 403 Forbidden — token has scopes but Graph rejected the call. ` +
      `Go to Azure Portal → App ${issuingAppId} → API Permissions → add all Teams scopes → Grant admin consent.`;
  } else {
    diagnosis = `❌ Graph call failed: ${teamsResult.error || chatsResult.error}`;
  }

  res.json({
    adminEmail,
    agentTag,
    mode,
    hasTeamsToken,
    hasTeamsScope,
    issuingApp: issuingAppLabel,
    issuingAppId,
    jwtScopes: jwtScopes.filter(s => !['openid', 'email', 'profile', 'offline_access'].includes(s)),
    teamsApiResult: teamsResult,
    chatsApiResult: chatsResult,
    diagnosis,
    fixSteps: hasTeamsScope ? null : [
      '1. Go to Azure Portal → App Registrations → 43a6d57e-8fe0-4b16-b095-96827473cfa9',
      '2. Authentication → Add redirect URI: http://localhost:5000/api/auth/microsoft/callback',
      '3. API Permissions → Add: Team.ReadBasic.All, Channel.ReadBasic.All, ChannelMessage.Send, ChannelMessage.Read.All, Chat.Read, Chat.ReadWrite, ChatMessage.Send, User.Read',
      '4. Grant admin consent for all permissions',
      `5. Sign out ${adminEmail} from Message Agent → Microsoft tab`,
      `6. Sign back in via Message Agent Step 1 → Microsoft tab`,
    ],
  });
}

/**
 * POST /api/agents/cf-browser-migrate
 * Launches a visible Chromium browser that auto-logs into CloudFuze,
 * selects channels/DMs, starts migration, and navigates to reports.
 */
async function startCFBrowserMigration(req, res) {
  try {
    const {
      sourceEmail, destinationEmail,
      sourcePlatform, destinationPlatform,
      combination,
      channelIds     = [],
      dmIds          = [],
      channelObjects = [],
      dmObjects      = [],
      cfSrcCloudId   = null,
      cfDstCloudId   = null,
      mappingType    = 'auto',
      userMappings   = [],
      userMappingCsvPath = null,
      cfAccountEmail = null,
    } = req.body;

    // Resolve CF login credentials: check env accounts then user-added JSON accounts.
    const env = require('../config/env');
    const fs2  = require('fs');
    const path2 = require('path');
    const CF_EXTRA_FILE2 = path2.join(__dirname, '../../data/cf-extra-accounts.json');
    let extraAccounts2 = [];
    try { extraAccounts2 = JSON.parse(fs2.readFileSync(CF_EXTRA_FILE2, 'utf8')); } catch { /* ignore */ }
    const allCFAccounts = [...(env.CF_ACCOUNTS || []), ...extraAccounts2];
    const selectedCFAccount = cfAccountEmail
      ? allCFAccounts.find(a => a.email === cfAccountEmail)
      : null;
    const cfUsername = selectedCFAccount?.email || env.MIGRATION_API_USERNAME;
    const cfPassword = selectedCFAccount?.password || env.MIGRATION_API_PASSWORD;

    const hasCloudsById = !!(cfSrcCloudId && cfDstCloudId);
    const hasCsvPath    = typeof userMappingCsvPath === 'string' && userMappingCsvPath.trim().length > 0;
    if ((!sourceEmail || !destinationEmail) && !hasCloudsById && !hasCsvPath) {
      return res.status(400).json({ error: 'sourceEmail and destinationEmail are required (or provide cfSrcCloudId + cfDstCloudId, or userMappingCsvPath)' });
    }
    if (!sourcePlatform || !destinationPlatform) {
      return res.status(400).json({ error: 'sourcePlatform and destinationPlatform are required' });
    }

    const { startSession, CF_REPORTS_URL } = require('../services/cfBrowserAutomation');

    const result = await startSession({
      sourceEmail,
      destinationEmail,
      sourcePlatform,
      destinationPlatform,
      combination:    combination || `${sourcePlatform} → ${destinationPlatform}`,
      channelIds:     Array.isArray(channelIds)     ? channelIds     : [],
      dmIds:          Array.isArray(dmIds)          ? dmIds          : [],
      channelObjects: Array.isArray(channelObjects) ? channelObjects : [],
      dmObjects:      Array.isArray(dmObjects)      ? dmObjects      : [],
      cfSrcCloudId:   cfSrcCloudId || null,
      cfDstCloudId:   cfDstCloudId || null,
      mappingType:    mappingType || 'auto',
      userMappings:   Array.isArray(userMappings) ? userMappings : [],
      userMappingCsvPath: typeof userMappingCsvPath === 'string' && userMappingCsvPath.trim()
        ? userMappingCsvPath.trim()
        : null,
      cfUsername,
      cfPassword,
    });

    if (!result.started) {
      return res.status(409).json({ error: result.reason });
    }

    res.status(202).json({
      started: true,
      reportsUrl: CF_REPORTS_URL,
      message: 'CloudFuze browser automation started. A Chromium window will open shortly.',
    });
  } catch (err) {
    logger.error(`startCFBrowserMigration error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/agents/cf-browser-events
 * Returns all progress events emitted by the active (or last) browser session.
 * The frontend polls this every second to render a live step log.
 */
function getCFBrowserEvents(_req, res) {
  try {
    const { getSessionEvents } = require('../services/cfBrowserAutomation');
    res.json(getSessionEvents());
  } catch (err) {
    logger.error(`getCFBrowserEvents error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/agents/cf-browser-abort
 * Stops an active CloudFuze browser automation session and closes the browser.
 */
async function abortCFBrowserMigration(req, res) {
  try {
    const { abortSession } = require('../services/cfBrowserAutomation');
    const result = await abortSession();
    res.json(result);
  } catch (err) {
    logger.error(`abortCFBrowserMigration error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  runAgents,
  runMessageAgent,
  seedMessageAgent,
  migrateMessageAgent,
  uploadMappingCsv,
  getMessageTargets,
  getMessageUserStatus,
  debugGoogleChat,
  debugTeams,
  getCFCloudAccounts,
  getCFChannels,
  getCFDMs,
  getCFChannelsAll,
  getCFChannelsCache,
  getCFReports,
  closeCFChatJobs,
  validateCFChatMigration,
  getCFBrowserEvents,
  startCFBrowserMigration,
  abortCFBrowserMigration,
  getExecutions, getExecution, getExecutionLogs, getStats,
  testConnections, getSourceUsers, getDestinationUsers, getMailboxStats, cleanDestination,
  generatePdf, getSourceMailboxStats, cleanSource,
  getCalendarEventCount, deleteCalendarEvents,
  getSourceCalendarStats, deleteSourceCalendarEvents,
};

