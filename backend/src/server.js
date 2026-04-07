const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const logger = require('./utils/logger');
const agentRoutes = require('./routes/agentRoutes');
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

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
  initScheduler();
});

server.timeout = 1800000;       // 30 min — large mailbox cleans can take >15 min
server.keepAliveTimeout = 1820000;
server.headersTimeout = 1830000;

module.exports = app;
