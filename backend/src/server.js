const express = require('express');
const cors = require('cors');
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

async function start() {
  try {
    await connectMongo(logger);
    // Sync OAuth tokens from MongoDB → local JSON file
    const { loadFromMongo } = require('./clients/oauthTokenStore');
    await loadFromMongo();
  } catch (e) {
    if (env.MONGODB_URI) {
      logger.error(`MongoDB connection failed: ${e?.message || e}`);
      process.exit(1);
    }
  }

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
