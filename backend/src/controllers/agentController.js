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

function generatePdf(req, res) {
  try {
    const execution = executionService.get(req.params.id);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    if (!execution.result) return res.status(400).json({ error: 'Execution has no results yet' });

    const { generateValidationPdf } = require('../utils/pdfGenerator');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="validation-report-${req.params.id.slice(0, 8)}.pdf"`);

    generateValidationPdf(execution, res);
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

module.exports = {
  runAgents, getExecutions, getExecution, getExecutionLogs, getStats,
  testConnections, getSourceUsers, getDestinationUsers, getMailboxStats, cleanDestination,
  generatePdf, getSourceMailboxStats, cleanSource,
  cleanSourceEmails, cleanSourceFolders, cleanSourceCalendars,
  cleanDestinationEmails, cleanDestinationFolders, cleanDestinationEvents,
  getCalendarEventCount, deleteCalendarEvents,
  getSourceCalendarStats, deleteSourceCalendarEvents,
  createOutlookData, cancelExecution, createTestData,
};

