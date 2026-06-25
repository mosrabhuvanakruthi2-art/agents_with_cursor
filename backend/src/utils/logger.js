const winston = require('winston');
const path = require('path');

const logsDir = path.resolve(__dirname, '../../logs');

function maskEmail(text) {
  if (typeof text !== 'string') return text;
  return text.replace(
    /([a-zA-Z0-9._%+-])([a-zA-Z0-9._%+-]+)(@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    (_, first, middle, domain) => `${first}${'*'.repeat(Math.min(middle.length, 5))}${domain}`
  );
}

const maskFormat = winston.format((info) => {
  info.message = maskEmail(info.message);
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    maskFormat(),
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'migration-qa' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, agent, executionId, route }) => {
          const prefix = [agent, executionId].filter(Boolean).join(' | ');
          const routeBit = route ? `${route}: ` : '';
          return `${timestamp} [${level}]${prefix ? ` (${prefix})` : ''} ${routeBit}${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

/**
 * Creates a file transport that writes logs for a specific execution to its own file.
 */
function createExecutionLogger(executionId) {
  const transport = new winston.transports.File({
    filename: path.join(logsDir, `${executionId}.log`),
  });
  logger.add(transport);
  return () => logger.remove(transport);
}

module.exports = logger;
module.exports.createExecutionLogger = createExecutionLogger;
module.exports.maskEmail = maskEmail;
