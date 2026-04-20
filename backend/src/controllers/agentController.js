const orchestrator = require('../orchestrator/AgentOrchestrator');
const executionService = require('../services/executionService');
const MigrationContext = require('../models/MigrationContext');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const logsDir = path.resolve(__dirname, '../../logs');

async function runAgents(req, res) {
  try {
    const { sourceEmail, destinationEmail, migrationType, includeMail, includeCalendar, testType, mappedPairs } = req.body;

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

module.exports = {
  runAgents, getExecutions, getExecution, getExecutionLogs, getStats,
  testConnections, getSourceUsers, getDestinationUsers, getMailboxStats, cleanDestination,
  generatePdf, getSourceMailboxStats, cleanSource,
  getCalendarEventCount, deleteCalendarEvents,
  getSourceCalendarStats, deleteSourceCalendarEvents,
};

