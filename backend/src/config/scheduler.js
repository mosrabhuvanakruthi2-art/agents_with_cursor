const cron = require('node-cron');
const env = require('./env');
const logger = require('../utils/logger');

let scheduledTask = null;

function initScheduler() {
  if (!env.SCHEDULER_ENABLED) {
    logger.info('Scheduler is disabled (SCHEDULER_ENABLED=false)');
    return;
  }

  if (!env.DEFAULT_SOURCE_EMAIL || !env.DEFAULT_DEST_EMAIL) {
    logger.warn('Scheduler enabled but DEFAULT_SOURCE_EMAIL or DEFAULT_DEST_EMAIL not set');
    return;
  }

  // Lazy-require to avoid circular dependency at module load time
  const orchestrator = require('../orchestrator/AgentOrchestrator');

  scheduledTask = cron.schedule('0 2 * * *', async () => {
    logger.info('Scheduled run starting (daily 2:00 AM)');
    try {
      const result = await orchestrator.runFullFlow({
        sourceEmail: env.DEFAULT_SOURCE_EMAIL,
        destinationEmail: env.DEFAULT_DEST_EMAIL,
        migrationType: 'FULL',
        includeMail: true,
        includeCalendar: true,
      });
      logger.info(`Scheduled run completed: ${result.status} (${result.executionId})`);
    } catch (err) {
      logger.error(`Scheduled run failed: ${err.message}`);
    }
  });

  logger.info('Scheduler initialized: daily at 2:00 AM');
}

function stopScheduler() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = { initScheduler, stopScheduler };
