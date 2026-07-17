const express = require('express');
const cors = require('cors');
const axios = require('axios');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectMongo } = require('./db/mongo');
const agentRoutes = require('./routes/agentRoutes');
const messageRoutes = require('./routes/messageRoutes');
const chatCleanerProxy = require('./routes/chatCleanerProxy');
const testRepositoryRoutes = require('./routes/testRepositoryRoutes');
const testCaseRoutes = require('./routes/testCaseRoutes');
const authRoutes = require('./routes/authRoutes');
const scopeRoutes = require('./routes/scopeRoutes');
const { initScheduler } = require('./config/scheduler');

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
});

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['text/plain', 'text/markdown'] }));

app.use('/api/agents', agentRoutes);
app.use('/api/agents', messageRoutes); // message product — same prefix, separate router
app.use('/api/chat-cleaner', chatCleanerProxy); // message cleanup (Google Chat / Teams / Slack)
app.use('/api/test-repository', testRepositoryRoutes);
app.use('/api/test-cases', testCaseRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/scope', scopeRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * If SLACK_USER_TOKEN is set in .env, resolve identity via Slack auth.test + users.info
 * and store it so the message product can use it without an OAuth popup. Re-runs each
 * startup so a rotated token is picked up. No-op when the var is unset.
 */
async function autoLoadSlackToken() {
  const token = env.SLACK_USER_TOKEN;
  if (!token || !token.startsWith('xox')) return;
  try {
    const { setSlackToken } = require('./clients/oauthTokenStore');
    const authRes = await axios.post(
      'https://slack.com/api/auth.test',
      new URLSearchParams({ token }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (!authRes.data?.ok) {
      logger.warn(`[slack] SLACK_USER_TOKEN auto-load failed: ${authRes.data?.error}`);
      return;
    }
    const { user_id: userId, team_id: teamId, team: teamName } = authRes.data;
    let email = '';
    try {
      const infoRes = await axios.get('https://slack.com/api/users.info', {
        headers: { Authorization: `Bearer ${token}` }, params: { user: userId },
      });
      if (infoRes.data?.ok) email = infoRes.data.user?.profile?.email || '';
    } catch { /* fall through */ }
    if (!email) email = `${userId}@slack-local.invalid`;
    setSlackToken({ email, userAccessToken: token, userId, teamId: teamId || '', teamName: teamName || '', scope: 'env', agent: 'message' });
    logger.info(`[slack] Auto-loaded SLACK_USER_TOKEN for ${email} (${teamName || teamId})`);
  } catch (err) {
    logger.warn(`[slack] SLACK_USER_TOKEN auto-load error: ${err.message}`);
  }
}

async function start() {
  // Start HTTP server immediately — do not block on MongoDB
  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT}`);
    initScheduler();
  });

  server.timeout = 1800000;
  server.keepAliveTimeout = 1820000;
  server.headersTimeout = 1830000;

  autoLoadSlackToken(); // fire-and-forget

  // Connect MongoDB in the background after the HTTP server is up
  if (env.MONGODB_URI) {
    connectMongo(logger)
      .then(async () => {
        try {
          const { loadFromMongo } = require('./clients/oauthTokenStore');
          await loadFromMongo();
          logger.info('MongoDB: OAuth tokens synced');
        } catch (e) {
          logger.warn(`MongoDB: token sync failed — ${e?.message || e}`);
        }
      })
      .catch((e) => {
        logger.error(
          `MongoDB connection failed: ${e?.message || e}\n` +
          'Fix: go to MongoDB Atlas → Network Access → Add IP Address → Allow Access From Anywhere (or add your current IP). ' +
          'Then restart the backend.'
        );
      });
  }
}

start();

module.exports = app;
