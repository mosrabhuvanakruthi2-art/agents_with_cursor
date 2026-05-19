const express = require('express');
const cors = require('cors');
const axios = require('axios');
const env = require('./config/env');
const logger = require('./utils/logger');
const { connectMongo } = require('./db/mongo');
const agentRoutes = require('./routes/agentRoutes');
const testRepositoryRoutes = require('./routes/testRepositoryRoutes');
const testCaseRoutes = require('./routes/testCaseRoutes');
const authRoutes = require('./routes/authRoutes');
const chatCleanerProxy = require('./routes/chatCleanerProxy');
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

app.use('/api/agents', agentRoutes);
app.use('/api/test-repository', testRepositoryRoutes);
app.use('/api/test-cases', testCaseRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/chat-cleaner', chatCleanerProxy);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * If SLACK_USER_TOKEN is set in .env, resolve identity via Slack auth.test + users.info
 * and store it in the token store so the Message Agent can use it without an OAuth popup.
 * Re-runs on every startup so a rotated token in .env is picked up automatically.
 */
async function autoLoadSlackToken() {
  const token = env.SLACK_USER_TOKEN;
  if (!token || !token.startsWith('xox')) return;
  try {
    const { setSlackToken } = require('./clients/oauthTokenStore');

    // 1. Verify token + get userId / teamId
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

    // 2. Resolve real email via users.info
    let email = '';
    try {
      const infoRes = await axios.get('https://slack.com/api/users.info', {
        headers: { Authorization: `Bearer ${token}` },
        params: { user: userId },
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
  try {
    await connectMongo(logger);
    // Sync OAuth tokens from MongoDB → local JSON file
    const { loadFromMongo } = require('./clients/oauthTokenStore');
    await loadFromMongo();
  } catch (e) {
    logger.warn(`MongoDB unavailable — running without persistence: ${e?.message || e}`);
  }

  // Auto-install pre-issued Slack user token from .env (if set)
  await autoLoadSlackToken();

  const server = app.listen(env.PORT, () => {
    logger.info(`Server running on port ${env.PORT}`);
    initScheduler();
  });

  server.timeout = 1800000;
  server.keepAliveTimeout = 1820000;
  server.headersTimeout = 1830000;
}

start();

module.exports = app;
