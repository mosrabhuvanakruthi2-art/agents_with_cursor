const orchestrator = require('../orchestrator/AgentOrchestrator');
const executionService = require('../services/executionService');
const MigrationContext = require('../models/MigrationContext');
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
      includeContacts,
      testType,
      mappedPairs,
      sourceProvider,
      destinationProvider,
      userEmailMappings,
      sourceAdminEmail,
      destAdminEmail,
      mode,
    } = req.body;
    const normalizedUserMappings = Array.isArray(userEmailMappings) ? userEmailMappings : [];

    // Bulk migration: multiple mapped pairs — phased execution
    // Phase 1 (parallel): create test data in all source accounts
    // Phase 2 (sequential): migrate each pair one at a time
    // Phase 3 (parallel): validate all destination mailboxes
    if (mappedPairs && Array.isArray(mappedPairs) && mappedPairs.length > 0) {
      const pairsData = mappedPairs.map((pair) => ({
        sourceEmail: pair.sourceEmail,
        destinationEmail: pair.destinationEmail,
        migrationType: migrationType || 'FULL',
        includeMail,
        includeCalendar,
        includeContacts,
        testType: testType || 'E2E',
        sourceProvider: pair.sourceProvider || 'google',
        destinationProvider: pair.destinationProvider || 'microsoft',
        userEmailMappings: normalizedUserMappings,
        sourceAdminEmail: sourceAdminEmail || '',
        destAdminEmail: destAdminEmail || '',
        migrationServerUrl: req.body.migrationServerUrl || '',
        migrationServerEmail: req.body.migrationServerEmail || '',
        migrationServerPassword: req.body.migrationServerPassword || '',
        mode: mode || 'email',
        contentOptions: req.body.contentOptions || null,
        jobName: req.body.jobName || '',
        excludeFileTypes: req.body.excludeFileTypes || '',
        replaceSpecialChar: req.body.replaceSpecialChar,
        sourcePath: req.body.sourcePath || '',
        destinationPath: req.body.destinationPath || '',
        sourceFolderName: req.body.sourceFolderName || '',
        contentUserFolders: Array.isArray(req.body.contentUserFolders) ? req.body.contentUserFolders : [],
        useExistingSource: Boolean(req.body.useExistingSource),
      }));
      const results = await orchestrator.runBulkFlow(pairsData);
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
      includeMail,
      includeCalendar,
      includeContacts,
      testType: testType || 'E2E',
      sourceProvider: sourceProvider || 'google',
      destinationProvider: destinationProvider || 'microsoft',
      userEmailMappings: normalizedUserMappings,
      sourceAdminEmail: sourceAdminEmail || '',
      destAdminEmail: destAdminEmail || '',
      migrationServerUrl: req.body.migrationServerUrl || '',
      migrationServerEmail: req.body.migrationServerEmail || '',
      migrationServerPassword: req.body.migrationServerPassword || '',
      mode: mode || 'email',
      contentOptions: req.body.contentOptions || null,
      jobName: req.body.jobName || '',
      excludeFileTypes: req.body.excludeFileTypes || '',
      replaceSpecialChar: req.body.replaceSpecialChar,
      sourcePath: req.body.sourcePath || '',
      destinationPath: req.body.destinationPath || '',
      sourceFolderName: req.body.sourceFolderName || '',
      contentUserFolders: Array.isArray(req.body.contentUserFolders) ? req.body.contentUserFolders : [],
      useExistingSource: Boolean(req.body.useExistingSource),
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

function getExecutions(_req, res) {
  const executions = executionService.getAll();
  res.json(executions);
}

function getExecution(req, res) {
  const execution = executionService.get(req.params.id);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }
  try {
    res.json(execution);
  } catch (err) {
    // Circular reference in result — return safe status subset so frontend stays responsive
    logger.warn(`getExecution serialization error (${req.params.id}): ${err.message}`);
    res.json({
      executionId: execution.executionId,
      status: execution.status,
      currentAgent: execution.currentAgent,
      progress: execution.progress,
      error: execution.error,
      createdAt: execution.createdAt,
      completedAt: execution.completedAt,
      _serializationError: 'Result contains non-serializable data — restart server to clear',
    });
  }
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

/** Map curated config users to the API shape used by the user-mapping UI. */
function mapConfigUsers(admin) {
  return (admin?.users || []).map((u) => ({
    id: u.email,
    email: u.email,
    displayName: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
    firstName: u.firstName || '',
    lastName: u.lastName || '',
  }));
}

// Content uses fine-grained service keys (googledrive/onedrive/sharepoint/…) but user
// listing is done at the ACCOUNT level (Gmail/Graph/Box). Normalize so a service key
// resolves to the right listing path instead of falling through to an empty list.
const USER_LISTING_PROVIDER = {
  googledrive: 'google', googleshareddrive: 'google', gmail: 'google', // (googleshareddrive kept)
  onedrive: 'microsoft', outlook: 'microsoft',
  sharepoint: 'sharepoint', box: 'box',
};

async function getSourceUsers(req, res) {
  try {
    const { adminEmail, provider: rawProvider } = req.query;
    const provider = USER_LISTING_PROVIDER[rawProvider] || rawProvider;
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail query param is required' });

    const config = loadUsersConfig();
    const admin = config.source?.admins?.find(
      (a) => a.email.toLowerCase() === adminEmail.toLowerCase()
    );
    const configUsers = mapConfigUsers(admin);

    // Live first (authoritative); the curated config list in data/users.json is a fallback
    // only. This keeps the list current — a stale config entry no longer silently caps it.
    let liveUsers = null;
    let domainHint = null;
    let liveErrMsg = null;
    try {
      if (provider === 'microsoft') {
        const outlookClient = require('../clients/outlookClient');
        logger.info(`getSourceUsers: fetching Microsoft tenant users (admin: ${adminEmail})`);
        const allUsers = await outlookClient.listUsers(adminEmail);
        const domain = adminEmail.split('@')[1]?.toLowerCase();
        liveUsers = domain
          ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain)
          : allUsers;
        // Admin UPN domain ≠ mailbox SMTP domain: guide to a domain that exists.
        if (domain && liveUsers.length === 0 && allUsers.length > 0) {
          const domains = [...new Set(allUsers.map((u) => u.email.split('@')[1]?.toLowerCase()).filter(Boolean))];
          domainHint = `No mailboxes found for @${domain} in this tenant. Available domains: ${domains.join(', ')}. Enter an admin email on one of these domains.`;
        }
      } else if (provider === 'slack') {
        const slackClient = require('../clients/slackClient');
        logger.info(`getSourceUsers: fetching Slack workspace users (admin: ${adminEmail})`);
        liveUsers = await slackClient.listWorkspaceUsers(adminEmail);
      } else if (provider === 'google' || !provider) {
        const gmailClient = require('../clients/gmailClient');
        liveUsers = await gmailClient.listDomainUsers(adminEmail);
      }
    } catch (liveErr) {
      logger.warn(`getSourceUsers: live fetch failed (${liveErr.message}) — trying config fallback`);
      liveErrMsg = liveErr.message;
    }

    if (liveUsers && liveUsers.length > 0) {
      return res.json({ adminEmail, users: liveUsers, source: provider === 'microsoft' ? 'graph' : 'gmail' });
    }

    // Box / SharePoint providers (from dev) — dedicated discovery.
    if (provider === 'box') {
      try {
        const boxClient = require('../clients/boxClient');
        logger.info(`getSourceUsers: fetching Box managed users (admin: ${adminEmail})`);
        const rawUsers = await boxClient.getUsers(adminEmail);
        const users = rawUsers.map((u) => ({ id: u.id, email: u.login, displayName: u.name, firstName: u.name.split(' ')[0] || '', lastName: u.name.split(' ').slice(1).join(' ') || '' }));
        return res.json({ adminEmail, users, source: 'box' });
      } catch (boxErr) {
        logger.warn(`getSourceUsers: Box API unavailable (${boxErr.message}), falling back to Microsoft Graph`);
        const outlookClient = require('../clients/outlookClient');
        const allUsers = await outlookClient.listUsers(adminEmail);
        const domain = adminEmail.split('@')[1]?.toLowerCase();
        const users = domain ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain) : allUsers;
        return res.json({ adminEmail, users, source: 'box-graph-fallback' });
      }
    }

    if (provider === 'sharepoint') {
      const outlookClient = require('../clients/outlookClient');
      logger.info(`getSourceUsers: fetching SharePoint/M365 tenant users (admin: ${adminEmail})`);
      const allUsers = await outlookClient.listUsers(adminEmail);
      const domain = adminEmail.split('@')[1]?.toLowerCase();
      const users = domain ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain) : allUsers;
      return res.json({ adminEmail, users, source: 'sharepoint' });
    }

    // Fallback to the curated config list, then domain guidance, then empty.
    if (configUsers.length > 0) {
      logger.info(`getSourceUsers: using config list (${configUsers.length} users) for admin ${adminEmail}`);
      return res.json({ adminEmail, users: configUsers, source: 'config' });
    }
    if (domainHint) return res.status(400).json({ error: domainHint });
    // Google: a live failure with no fallback almost always means the service account
    // isn't authorized for Domain-Wide Delegation in THIS user's Workspace domain.
    if ((provider === 'google' || !provider) && liveErrMsg) {
      const domain = (adminEmail.split('@')[1] || '').toLowerCase();
      return res.status(400).json({
        error: `Couldn't list Google users for @${domain}: ${liveErrMsg}. `
          + `Authorize the service account's Client ID for Domain-Wide Delegation in the ${domain} `
          + `Google Admin console (scopes: admin.directory.user.readonly, drive), then retry.`,
      });
    }
    return res.json({ adminEmail, users: liveUsers || [], source: provider === 'microsoft' ? 'graph' : 'gmail' });
  } catch (err) {
    logger.error(`getSourceUsers error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function getDestinationUsers(req, res) {
  try {
    const { adminEmail, provider: rawProvider } = req.query;
    const provider = USER_LISTING_PROVIDER[rawProvider] || rawProvider;

    const config = loadUsersConfig();
    const admin = config.destination?.admins?.find(
      (a) => a.email.toLowerCase() === (adminEmail || '').toLowerCase()
    );
    const configUsers = mapConfigUsers(admin);

    // Live first (authoritative); curated config list is a fallback only.
    let liveUsers = null;
    let domainHint = null;
    try {
      if (provider === 'google') {
        const gmailClient = require('../clients/gmailClient');
        logger.info(`getDestinationUsers: fetching Google Workspace users (admin: ${adminEmail})`);
        liveUsers = await gmailClient.listDomainUsers(adminEmail);
      } else if (provider === 'slack') {
        const slackClient = require('../clients/slackClient');
        logger.info(`getDestinationUsers: fetching Slack workspace users (admin: ${adminEmail})`);
        liveUsers = await slackClient.listWorkspaceUsers(adminEmail);
      } else if (provider === 'microsoft' || !provider) {
        const outlookClient = require('../clients/outlookClient');
        logger.info(`getDestinationUsers: fetching Microsoft tenant users via Graph API (admin: ${adminEmail || 'none'})`);
        const allTenantUsers = await outlookClient.listUsers(adminEmail);
        const domain = adminEmail ? adminEmail.split('@')[1]?.toLowerCase() : null;
        liveUsers = domain
          ? allTenantUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain)
          : allTenantUsers;
        if (domain && liveUsers.length === 0 && allTenantUsers.length > 0) {
          const domains = [...new Set(allTenantUsers.map((u) => u.email.split('@')[1]?.toLowerCase()).filter(Boolean))];
          domainHint = `No mailboxes found for @${domain} in this tenant. Available domains: ${domains.join(', ')}. Enter an admin email on one of these domains.`;
        }
      }
    } catch (liveErr) {
      logger.warn(`getDestinationUsers: live fetch failed (${liveErr.message}) — trying config fallback`);
    }

    if (liveUsers && liveUsers.length > 0) {
      logger.info(`getDestinationUsers: ${liveUsers.length} users (live)`);
      return res.json({ adminEmail, users: liveUsers, total: liveUsers.length, source: provider === 'google' ? 'gmail' : 'graph' });
    }
    // Box / SharePoint providers (from dev) — dedicated discovery.
    if (provider === 'box') {
      try {
        const boxClient = require('../clients/boxClient');
        logger.info(`getDestinationUsers: fetching Box managed users (admin: ${adminEmail})`);
        const rawUsers = await boxClient.getUsers(adminEmail);
        const users = rawUsers.map((u) => ({ id: u.id, email: u.login, displayName: u.name, firstName: u.name.split(' ')[0] || '', lastName: u.name.split(' ').slice(1).join(' ') || '' }));
        return res.json({ adminEmail, users, total: users.length, source: 'box' });
      } catch (boxErr) {
        logger.warn(`getDestinationUsers: Box API unavailable (${boxErr.message}), falling back to Microsoft Graph`);
        const outlookClient = require('../clients/outlookClient');
        const allUsers = await outlookClient.listUsers(adminEmail);
        const domain = adminEmail ? adminEmail.split('@')[1]?.toLowerCase() : null;
        const users = domain ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain) : allUsers;
        return res.json({ adminEmail, users, total: users.length, source: 'box-graph-fallback' });
      }
    }

    if (provider === 'sharepoint') {
      const outlookClient = require('../clients/outlookClient');
      logger.info(`getDestinationUsers: fetching SharePoint/M365 tenant users (admin: ${adminEmail})`);
      const allUsers = await outlookClient.listUsers(adminEmail);
      const domain = adminEmail ? adminEmail.split('@')[1]?.toLowerCase() : null;
      const users = domain ? allUsers.filter((u) => u.email.split('@')[1]?.toLowerCase() === domain) : allUsers;
      return res.json({ adminEmail, users, total: users.length, source: 'sharepoint' });
    }

    // Fallback to the curated config list, then domain guidance, then empty.
    if (configUsers.length > 0) {
      logger.info(`getDestinationUsers: using config list (${configUsers.length} users) for admin ${adminEmail}`);
      return res.json({ adminEmail, users: configUsers, total: configUsers.length, source: 'config' });
    }
    if (domainHint) {
      logger.warn(`getDestinationUsers: ${domainHint}`);
      return res.status(400).json({ error: domainHint });
    }
    return res.json({ adminEmail, users: [], total: 0, source: provider === 'google' ? 'gmail' : 'graph' });
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

    const [folders, totalMessages, recoverableCount] = await Promise.all([
      outlookClient.getMailFolders(email),
      outlookClient.getTotalMessageCount(email),
      outlookClient.getRecoverableItemsCount(email),
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

    const result = {
      email,
      mailCount: totalMessages + recoverableCount,
      recoverableCount,
      folderCount: customFolderCount,
      calendarCount: 0,
      eventCount: 0,
    };

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

/**
 * Run the content validation agent on demand for an execution that completed without a
 * validationSummary (e.g. CloudFuze returned NOT_PROCESSED so the in-flow validation was skipped,
 * or the run predates deep validation). Persists the result so the PDF + Results view light up.
 * Returns the validationSummary, or null if this isn't a content run / no validator is registered.
 */
async function ensureContentValidation(execution) {
  const ctx = execution.context || {};
  const result = execution.result || {};
  const isContent = ctx.domain === 'content' || ctx.mode === 'content';
  if (!isContent || result.validationSummary) return result.validationSummary || null;

  const { resolve } = require('../orchestrator/agentRegistry');
  const set = resolve(ctx.domain || 'content', ctx.sourceProvider, ctx.destinationProvider);
  if (!set?.ValidationAgent) return null;

  const mr = result.migrationResult || {};
  // Rebuild the context the validation agent reads, pulling migration outputs from the stored result.
  const context = {
    ...ctx,
    executionId: execution.id || ctx.executionId,
    migratedUsers: ctx.migratedUsers || mr.migratedUsers || [],
    skippedUsers: ctx.skippedUsers || mr.skippedUsers || [],
    permissionMapping: ctx.permissionMapping || mr.permissionMapping || null,
    contentMigrationReport: result.contentMigrationReport || mr.contentMigrationReport || null,
    migrationJobDetails: ctx.migrationJobDetails || mr.migrationJobDetails || null,
  };

  logger.info(`[generatePdf] No validationSummary for ${execution.id} — running content validation on demand`);
  const summary = await new set.ValidationAgent().run(context);
  executionService.update(execution.id, { result: { ...result, validationSummary: summary } });
  execution.result = { ...result, validationSummary: summary };
  return summary;
}

async function generatePdf(req, res) {
  try {
    const execution = executionService.get(req.params.id);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    if (!execution.result) return res.status(400).json({ error: 'Execution has no results yet' });

    const { generateValidationPdf, generateContentValidationPdf } = require('../utils/pdfGenerator');

    // Content migrations have their own check-list report (structure/permissions/versions/
    // shared links); mail uses the deep-mail report.
    const ctx = execution.context || {};
    const isContent = ctx.domain === 'content' || ctx.mode === 'content'
      || execution.result?.validationSummary?.domain === 'content';

    // Content: if validation never ran (e.g. CloudFuze NOT_PROCESSED skipped it), run it now so a
    // report is always downloadable after a completed run — same UX as mail.
    if (isContent && !execution.result.validationSummary) {
      try { await ensureContentValidation(execution); }
      catch (err) { logger.warn(`[generatePdf] on-demand validation failed for ${req.params.id}: ${err.message}`); }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="validation-report-${req.params.id.slice(0, 8)}.pdf"`);

    if (isContent) generateContentValidationPdf(execution, res);
    else generateValidationPdf(execution, res);
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
    const emailDomain = email.toLowerCase().split('@')[1] || '';
    const gmailClientCheck = require('../clients/gmailClient');
    const tenant2Dwd = Array.isArray(envCheck.GOOGLE_TENANT_2_DOMAINS) && envCheck.GOOGLE_TENANT_2_DOMAINS.includes(emailDomain) && gmailClientCheck.hasServiceAccount('2');
    const tenant3Dwd = Array.isArray(envCheck.GOOGLE_TENANT_3_DOMAINS) && envCheck.GOOGLE_TENANT_3_DOMAINS.includes(emailDomain);
    const isDwdUser = tenant2Dwd || tenant3Dwd;
    if (!isDwdUser && !envCheck.googleAccounts.has(email.toLowerCase())) {
      return res.json({ email, mailCount: 0, folderCount: 0, calendarCount: 0, eventCount: 0, noToken: true });
    }
    const gmailClient = require('../clients/gmailClient');
    const stats = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, ...stats });
  } catch (err) {
    require('../utils/logger').error('getSourceMailboxStats error: ' + err.message);
    res.json({ email: req.query.email, mailCount: 0, folderCount: 0, calendarCount: 0, eventCount: 0, tokenError: true, tokenErrorMsg: err.message });
  }
}

async function cleanSourceEmails(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const gmailClient = require('../clients/gmailClient');
    const summary = await gmailClient.cleanGmailEmailsOnly(email);
    const after = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    require('../utils/logger').error('cleanSourceEmails error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function cleanSourceFolders(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const gmailClient = require('../clients/gmailClient');
    const summary = await gmailClient.cleanGmailFoldersOnly(email);
    const after = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    require('../utils/logger').error('cleanSourceFolders error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function cleanSourceCalendars(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const gmailClient = require('../clients/gmailClient');
    const summary = await gmailClient.cleanGmailCalendarsOnly(email);
    const after = await gmailClient.getGmailMailboxStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    require('../utils/logger').error('cleanSourceCalendars error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function _getOutlookAfterStats(email) {
  const outlookClient = require('../clients/outlookClient');
  const [folders, totalMessages, recoverableCount] = await Promise.all([
    outlookClient.getMailFolders(email),
    outlookClient.getTotalMessageCount(email),
    outlookClient.getRecoverableItemsCount(email),
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
  let eventCount = 0;
  try {
    const calendars = await outlookClient.getCalendars(email);
    for (const cal of calendars) {
      if (cal.name === 'Birthdays' || cal.name.toLowerCase().includes('holidays') || cal.canEdit === false) continue;
      eventCount += await outlookClient.getEventCount(email, cal.id);
    }
  } catch { /* best-effort */ }
  return { mailCount: totalMessages + recoverableCount, recoverableCount, folderCount: customFolderCount, eventCount };
}

async function cleanDestinationEmails(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const outlookClient = require('../clients/outlookClient');
    const summary = await outlookClient.cleanOutlookEmailsOnly(email);
    const after = await _getOutlookAfterStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    logger.error('cleanDestinationEmails error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function cleanDestinationFolders(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const outlookClient = require('../clients/outlookClient');
    const summary = await outlookClient.cleanOutlookFoldersOnly(email);
    const after = await _getOutlookAfterStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    logger.error('cleanDestinationFolders error: ' + err.message);
    res.status(500).json({ error: err.message });
  }
}

async function cleanDestinationEvents(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);
    const outlookClient = require('../clients/outlookClient');
    const summary = await outlookClient.cleanOutlookEventsOnly(email);
    const after = await _getOutlookAfterStats(email);
    res.json({ email, deleted: summary, after });
  } catch (err) {
    logger.error('cleanDestinationEvents error: ' + err.message);
    res.status(500).json({ error: err.message });
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
 * Returns calendar + event counts directly from the Google Calendar API.
 */
async function getSourceCalendarStats(req, res) {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const gmailClient = require('../clients/gmailClient');
    const { google } = require('googleapis');
    const calAuth = gmailClient.getCalendarAuthForEmail(email);
    const cal = google.calendar({ version: 'v3', auth: calAuth });
    let eventCount = 0;
    let calendarCount = 0;
    const calList = await cal.calendarList.list({ maxResults: 250 });
    for (const c of calList.data.items || []) {
      if (c.accessRole === 'reader') continue;
      if (!c.primary) calendarCount++;
      try {
        const ev = await cal.events.list({ calendarId: c.id, maxResults: 250, singleEvents: false });
        eventCount += (ev.data.items || []).length;
      } catch { /* skip */ }
    }
    res.json({ email, eventCount, calendarCount });
  } catch (err) {
    logger.error(`getSourceCalendarStats error for ${req.query.email}: ${err.message}`);
    res.json({ email: req.query.email, eventCount: 0, calendarCount: 0, error: err.message });
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
 * POST /agents/executions/:id/cancel
 * Marks a running execution as cancelled. The orchestrator and MigrationAgent
 * check this flag between steps / poll iterations and stop gracefully.
 */
async function cancelExecution(req, res) {
  try {
    const { id } = req.params;
    const execution = executionService.get(id);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    if (execution.status !== 'RUNNING') {
      return res.status(400).json({ error: `Execution is not running (status: ${execution.status})` });
    }
    executionService.cancel(id);
    logger.info(`Execution ${id} cancelled by user`);
    res.json({ ok: true, executionId: id, status: 'CANCELLED' });
  } catch (err) {
    logger.error(`cancelExecution error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/create-outlook-data
 * Body: { sourceEmail, destinationEmail?, testType? }
 *
 * Runs OutlookTestDataAgent standalone — lists mailbox folders, then fills
 * Inbox, Drafts, Sent Items, Junk Email, Deleted Items, and Migration_Test_*
 * custom folders via the create-mails-outlook Spring Boot service.
 * Returns 202 immediately; poll GET /agents/executions/:id for progress.
 */
async function createOutlookData(req, res) {
  try {
    const { sourceEmail, destinationEmail, testType } = req.body;
    if (!sourceEmail) return res.status(400).json({ error: 'sourceEmail is required' });

    const OutlookTestDataAgent = require('../agents/outlook/OutlookTestDataAgent');
    const MigrationContext = require('../models/MigrationContext');
    const executionService = require('../services/executionService');

    const context = new MigrationContext({
      sourceEmail,
      destinationEmail: destinationEmail || sourceEmail,
      migrationType: 'FULL',
      includeMail: true,
      includeCalendar: false,
      testType: testType || 'E2E',
    });

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: 'OutlookTestDataAgent',
      progress: 'OutlookTestDataAgent: listing folders, provisioning test mail data…',
    });

    res.status(202).json({
      executionId: context.executionId,
      status: 'RUNNING',
      message: 'Outlook data creation started. Poll GET /api/agents/executions/:id for progress.',
      context: context.toJSON(),
    });

    setImmediate(async () => {
      const agent = new OutlookTestDataAgent();
      try {
        executionService.update(context.executionId, {
          currentAgent: 'CleanupAgent',
          progress: 'CleanupAgent: cleaning source mailbox before test data creation…',
        });
        const CleanupAgent = require('../agents/cleanup/CleanupAgent');
        const cleanupAgent = new CleanupAgent();
        await cleanupAgent.run({ ...context, destinationEmail: null });
      } catch (cleanErr) {
        logger.warn(`createOutlookData: cleanup warning (non-blocking): ${cleanErr.message}`);
      }
      executionService.update(context.executionId, {
        currentAgent: 'OutlookTestDataAgent',
        progress: 'OutlookTestDataAgent: listing folders, provisioning test mail data…',
      });
      try {
        const result = await agent.run(context);
        executionService.update(context.executionId, {
          status: 'COMPLETED',
          result: { executionId: context.executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], sourceData: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`createOutlookData failed: ${err.message}`);
        executionService.update(context.executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId: context.executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`createOutlookData error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/create-test-data
 * Body: { sourceEmail, destinationEmail?, sourceProvider ('google'|'microsoft'), testType? }
 *
 * Unified endpoint: routes to GmailTestDataAgent or OutlookTestDataAgent based on sourceProvider.
 * Returns 202; poll GET /agents/executions/:id for completion.
 */
async function createTestData(req, res) {
  try {
    const { sourceEmail, destinationEmail, sourceProvider, testType } = req.body;
    if (!sourceEmail) return res.status(400).json({ error: 'sourceEmail is required' });

    const isOutlook = (sourceProvider || 'google') === 'microsoft';
    const AgentClass = isOutlook
      ? require('../agents/outlook/OutlookTestDataAgent')
      : require('../agents/gmail/GmailTestDataAgent');
    const agentName = isOutlook ? 'OutlookTestDataAgent' : 'GmailTestDataAgent';

    const context = new MigrationContext({
      sourceEmail,
      destinationEmail: destinationEmail || sourceEmail,
      migrationType: 'FULL',
      includeMail: true,
      includeCalendar: false,
      testType: testType || 'E2E',
      sourceProvider: sourceProvider || 'google',
      destinationProvider: isOutlook ? 'microsoft' : 'google',
    });

    executionService.create(context);
    executionService.update(context.executionId, {
      status: 'RUNNING',
      currentAgent: agentName,
      progress: isOutlook
        ? 'OutlookTestDataAgent: listing folders, provisioning test mail data…'
        : 'GmailTestDataAgent: creating labels, mail, drafts…',
    });

    res.status(202).json({
      executionId: context.executionId,
      status: 'RUNNING',
      message: 'Test data creation started. Poll GET /api/agents/executions/:id for progress.',
      context: context.toJSON(),
    });

    setImmediate(async () => {
      const agent = new AgentClass();
      try {
        executionService.update(context.executionId, {
          currentAgent: 'CleanupAgent',
          progress: 'CleanupAgent: cleaning source mailbox before test data creation…',
        });
        const CleanupAgent = require('../agents/cleanup/CleanupAgent');
        const cleanupAgent = new CleanupAgent();
        await cleanupAgent.run({ ...context, destinationEmail: null });
      } catch (cleanErr) {
        logger.warn(`createTestData: cleanup warning (non-blocking): ${cleanErr.message}`);
      }
      executionService.update(context.executionId, {
        currentAgent: agentName,
        progress: isOutlook
          ? 'OutlookTestDataAgent: listing folders, provisioning test mail data…'
          : 'GmailTestDataAgent: creating labels, mail, drafts…',
      });
      try {
        const result = await agent.run(context);
        executionService.update(context.executionId, {
          status: 'COMPLETED',
          result: { executionId: context.executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], sourceData: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`createTestData failed: ${err.message}`);
        executionService.update(context.executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId: context.executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`createTestData error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function resumeExecution(req, res) {
  try {
    const { id } = req.params;
    const execution = executionService.get(id);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    if (execution.status !== 'INTERRUPTED') {
      return res.status(400).json({ error: `Execution cannot be resumed (status: ${execution.status})` });
    }
    res.json({ ok: true, executionId: id, message: 'Resuming execution…' });
    const orchestrator = require('../orchestrator/AgentOrchestrator');
    orchestrator.resumeFlow(id).catch((err) => {
      logger.error(`Resume execution ${id} failed: ${err.message}`);
    });
  } catch (err) {
    logger.error(`resumeExecution error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /agents/box/users?adminEmail=admin@domain.com
 * List all active managed Box users for the given admin account.
 */
async function getBoxUsers(req, res) {
  try {
    const { adminEmail } = req.query;
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail query param is required' });
    const boxClient = require('../clients/boxClient');
    const users = await boxClient.getUsers(adminEmail);
    const mapped = users.map((u) => ({ id: u.id, email: u.login, displayName: u.name }));
    res.json({ adminEmail, users: mapped, total: mapped.length });
  } catch (err) {
    logger.error(`getBoxUsers error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/create-box-data
 * Body: { adminEmail, targetUserId? }
 *
 * Runs BoxTestDataAgent — creates the full QA data set in Box cloud.
 * adminEmail must already be connected via GET /api/auth/box/url.
 * targetUserId (optional): Box user ID to create data as (As-User impersonation).
 * Returns 202 immediately; poll GET /api/agents/executions/:id for progress.
 */
async function createBoxData(req, res) {
  try {
    const { adminEmail, targetUserId } = req.body;
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail is required' });

    const BoxTestDataAgent = require('../agents/box/BoxTestDataAgent');
    const executionService = require('../services/executionService');
    const { v4: uuidv4 } = require('uuid');

    const executionId = uuidv4();
    executionService.create({
      executionId,
      status: 'RUNNING',
      currentAgent: 'BoxTestDataAgent',
      progress: 'BoxTestDataAgent: starting Box data creation…',
      createdAt: new Date().toISOString(),
    });

    res.status(202).json({
      executionId,
      message: 'Box data creation started. Poll GET /api/agents/executions/:id for progress.',
    });

    setImmediate(async () => {
      const agent = new BoxTestDataAgent();
      try {
        executionService.update(executionId, {
          currentAgent: 'BoxTestDataAgent',
          progress: 'BoxTestDataAgent: creating folders, uploading files, building versions…',
        });
        const result = await agent.run({ adminEmail, boxTargetUserId: targetUserId || null, executionId });
        executionService.update(executionId, {
          status: 'COMPLETED',
          result: { executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], boxData: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`createBoxData failed: ${err.message}`);
        executionService.update(executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`createBoxData error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/create-box-automation-data
 * Body: { adminEmail, collaboratorEmail?, targetUserId? }
 *
 * Runs BoxAutomationDataAgent — creates "AUTOMATION BOX" root folder with all
 * 17 migration QA scenarios inside it.
 * adminEmail must already be connected via GET /api/auth/box/url
 * (or BOX_DEVELOPER_TOKEN set in .env).
 * collaboratorEmail (optional): email to add as collaborator in permission scenarios.
 * Returns 202; poll GET /api/agents/executions/:id for progress.
 */
async function createBoxAutomationData(req, res) {
  try {
    const { adminEmail, collaboratorEmail, targetUserId } = req.body;
    if (!adminEmail) return res.status(400).json({ error: 'adminEmail is required' });

    const BoxAutomationDataAgent = require('../agents/box/BoxAutomationDataAgent');
    const executionService = require('../services/executionService');
    const { v4: uuidv4 } = require('uuid');

    const executionId = uuidv4();
    executionService.create({
      executionId,
      status: 'RUNNING',
      currentAgent: 'BoxAutomationDataAgent',
      progress: 'BoxAutomationDataAgent: creating AUTOMATION BOX root folder…',
      createdAt: new Date().toISOString(),
    });

    res.status(202).json({
      executionId,
      message: 'Box automation data creation started. Poll GET /api/agents/executions/:id for progress.',
    });

    setImmediate(async () => {
      const agent = new BoxAutomationDataAgent();
      try {
        executionService.update(executionId, {
          currentAgent: 'BoxAutomationDataAgent',
          progress: 'BoxAutomationDataAgent: running 17 migration QA scenarios…',
        });
        const result = await agent.run({
          adminEmail,
          collaboratorEmail: collaboratorEmail || null,
          boxTargetUserId: targetUserId || null,
          executionId,
        });
        executionService.update(executionId, {
          status: 'COMPLETED',
          result: { executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], boxAutomation: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`createBoxAutomationData failed: ${err.message}`);
        executionService.update(executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`createBoxAutomationData error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/create-drive-data
 * Body: { sourceEmail, editorEmail?, viewerEmail?, sourceFolderName? }
 *
 * Runs DriveTestDataAgent — creates the full QA data set in Google My Drive.
 * sourceEmail must belong to a tenant with a service account (DWD) or have a stored OAuth token.
 * sourceFolderName defaults to "Agent My Drive" (matches the CSV migration path /Agent My Drive).
 * Returns 202 immediately; poll GET /api/agents/executions/:id for progress.
 */
async function createDriveData(req, res) {
  try {
    const { sourceEmail, editorEmail, viewerEmail, sourceFolderName } = req.body;
    if (!sourceEmail) return res.status(400).json({ error: 'sourceEmail is required' });

    const DriveTestDataAgent = require('../agents/drive/DriveTestDataAgent');
    const { v4: uuidv4 } = require('uuid');

    const executionId = uuidv4();
    const folderName = sourceFolderName || 'Agent My Drive';
    executionService.create({
      executionId,
      toJSON: () => ({ executionId, sourceEmail, sourceFolderName: folderName }),
    });

    res.status(202).json({
      executionId,
      message: 'Drive data creation started. Poll GET /api/agents/executions/:id for progress.',
    });

    setImmediate(async () => {
      const agent = new DriveTestDataAgent();
      try {
        executionService.update(executionId, {
          currentAgent: 'DriveTestDataAgent',
          progress: 'DriveTestDataAgent: creating folders, uploading files, building versions, setting permissions…',
        });
        const result = await agent.run({
          sourceEmail,
          editorEmail:      editorEmail || null,
          viewerEmail:      viewerEmail || null,
          sourceFolderName: folderName,
          executionId,
        });
        executionService.update(executionId, {
          status: 'COMPLETED',
          result: { executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], driveData: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`createDriveData failed: ${err.message}`);
        executionService.update(executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`createDriveData error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function getContentStats(req, res) {
  try {
    const { email, adminEmail, provider } = req.query;
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!provider) return res.status(400).json({ error: 'provider is required (box or sharepoint)' });

    if (provider === 'box') {
      const boxClient = require('../clients/boxClient');
      const adm = adminEmail || email;
      const stats = await boxClient.getBoxContentStats(adm, email);
      return res.json(stats);
    }

    return res.status(400).json({ error: `Provider "${provider}" is not yet supported for content stats` });
  } catch (err) {
    logger.error(`getContentStats error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function cleanContent(req, res) {
  try {
    const { email, adminEmail, provider } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    if (provider === 'box') {
      const boxClient = require('../clients/boxClient');
      const adm = adminEmail || email;
      const result = await boxClient.cleanBoxContent(adm, email);
      const after = await boxClient.getBoxContentStats(adm, email);
      return res.json({ email, deleted: result, after });
    }

    return res.status(400).json({ error: `Provider "${provider}" is not yet supported for content cleanup` });
  } catch (err) {
    logger.error(`cleanContent error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function cleanContentFiles(req, res) {
  try {
    const { email, adminEmail, provider } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    if (provider === 'box') {
      const boxClient = require('../clients/boxClient');
      const adm = adminEmail || email;
      const result = await boxClient.cleanBoxFiles(adm, email);
      const after = await boxClient.getBoxContentStats(adm, email);
      return res.json({ email, deleted: result, after });
    }

    return res.status(400).json({ error: `Provider "${provider}" is not yet supported` });
  } catch (err) {
    logger.error(`cleanContentFiles error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

async function cleanContentFolders(req, res) {
  try {
    const { email, adminEmail, provider } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    req.setTimeout(1800000);
    res.setTimeout(1800000);

    if (provider === 'box') {
      const boxClient = require('../clients/boxClient');
      const adm = adminEmail || email;
      const result = await boxClient.cleanBoxFolders(adm, email);
      const after = await boxClient.getBoxContentStats(adm, email);
      return res.json({ email, deleted: result, after });
    }

    return res.status(400).json({ error: `Provider "${provider}" is not yet supported` });
  } catch (err) {
    logger.error(`cleanContentFolders error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/setup-drive-shared-links
 * Body: {
 *   sourceEmail,
 *   rootFolderId,           — ID of "Agent My Drive" folder
 *   existingSharedItems,    — [{label, id}, ...] items whose public links to remove
 *   domain?                 — defaults to 'storefuze.com'
 * }
 *
 * 1. Removes public "anyone" links from all previously shared items.
 * 2. Creates "Agent Shared Links" folder with 5 files:
 *    - 2 files with "anyone with the link" (viewer + editor)
 *    - 3 files with domain-restricted link for storefuze.com (viewer + commenter + editor)
 * Returns 202; poll GET /api/agents/executions/:id for progress.
 */
async function setupDriveSharedLinks(req, res) {
  try {
    const { sourceEmail, rootFolderId, existingSharedItems = [], domain = 'storefuze.com' } = req.body;
    if (!sourceEmail) return res.status(400).json({ error: 'sourceEmail is required' });
    if (!rootFolderId) return res.status(400).json({ error: 'rootFolderId is required' });

    const DriveTestDataAgent = require('../agents/drive/DriveTestDataAgent');
    const { v4: uuidv4 } = require('uuid');

    const executionId = uuidv4();
    executionService.create({
      executionId,
      toJSON: () => ({ executionId, sourceEmail, rootFolderId, domain }),
    });

    res.status(202).json({
      executionId,
      message: 'Shared links setup started. Poll GET /api/agents/executions/:id for progress.',
    });

    setImmediate(async () => {
      const agent = new DriveTestDataAgent();
      try {
        executionService.update(executionId, {
          status: 'RUNNING',
          currentAgent: 'DriveTestDataAgent',
          progress: 'DriveTestDataAgent: removing public links, creating Agent Shared Links folder…',
        });
        const result = await agent.setupSharedLinksFolder(sourceEmail, rootFolderId, existingSharedItems, domain);
        executionService.update(executionId, {
          status: 'COMPLETED',
          result: { executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], sharedLinksSetup: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`setupDriveSharedLinks failed: ${err.message}`);
        executionService.update(executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`setupDriveSharedLinks error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /agents/update-drive-versions
 * Body: { sourceEmail, versionedFiles: [{name, id}, ...], fromVersion?, toVersion? }
 *
 * Appends additional versions to existing Drive files — used for delta migration testing.
 * fromVersion defaults to 5 (initial agent creates 5). toVersion defaults to 10.
 * Returns 202 immediately; poll GET /api/agents/executions/:id for progress.
 */
async function updateDriveVersions(req, res) {
  try {
    const { sourceEmail, versionedFiles, fromVersion = 5, toVersion = 10 } = req.body;
    if (!sourceEmail) return res.status(400).json({ error: 'sourceEmail is required' });
    if (!Array.isArray(versionedFiles) || versionedFiles.length === 0) {
      return res.status(400).json({ error: 'versionedFiles array is required (e.g. [{name, id}, ...])' });
    }
    if (fromVersion >= toVersion) {
      return res.status(400).json({ error: `fromVersion (${fromVersion}) must be less than toVersion (${toVersion})` });
    }

    const DriveTestDataAgent = require('../agents/drive/DriveTestDataAgent');
    const { v4: uuidv4 } = require('uuid');

    const executionId = uuidv4();
    executionService.create({
      executionId,
      toJSON: () => ({ executionId, sourceEmail, fromVersion, toVersion, files: versionedFiles.map((f) => f.name) }),
    });

    res.status(202).json({
      executionId,
      message: `Adding versions ${fromVersion + 1}–${toVersion} to ${versionedFiles.length} file(s). Poll GET /api/agents/executions/:id for progress.`,
    });

    setImmediate(async () => {
      const agent = new DriveTestDataAgent();
      try {
        executionService.update(executionId, {
          status: 'RUNNING',
          currentAgent: 'DriveTestDataAgent',
          progress: `DriveTestDataAgent: uploading versions ${fromVersion + 1}–${toVersion} to ${versionedFiles.length} file(s)…`,
        });
        const result = await agent.updateVersions(sourceEmail, versionedFiles, fromVersion, toVersion);
        executionService.update(executionId, {
          status: 'COMPLETED',
          result: { executionId, status: 'COMPLETED', agentResults: [agent.toJSON()], updatedVersions: result },
          progress: 'Completed',
          completedAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.error(`updateDriveVersions failed: ${err.message}`);
        executionService.update(executionId, {
          status: 'FAILED',
          error: err.message,
          result: { executionId, status: 'FAILED', error: err.message, agentResults: [agent.toJSON()] },
          progress: `Failed: ${err.message}`,
          completedAt: new Date().toISOString(),
        });
      }
    });
  } catch (err) {
    logger.error(`updateDriveVersions error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  runAgents, getExecutions, getExecution, getExecutionLogs, getStats,
  testConnections, getSourceUsers, getDestinationUsers, getMailboxStats, cleanDestination,
  generatePdf, getSourceMailboxStats, cleanSource,
  cleanSourceEmails, cleanSourceFolders, cleanSourceCalendars,
  cleanDestinationEmails, cleanDestinationFolders, cleanDestinationEvents,
  getCalendarEventCount, deleteCalendarEvents,
  getSourceCalendarStats, deleteSourceCalendarEvents,
  createOutlookData, cancelExecution, createTestData, resumeExecution,
  getBoxUsers, createBoxData, createBoxAutomationData,
  createDriveData, updateDriveVersions, setupDriveSharedLinks,
  getContentStats, cleanContent, cleanContentFiles, cleanContentFolders,
};

