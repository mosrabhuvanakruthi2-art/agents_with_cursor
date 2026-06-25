const logger = require('./logger');

/**
 * Retries an async function with exponential backoff.
 * Respects Retry-After header on 429 responses.
 */
async function retryWithBackoff(fn, options = {}) {
  const {
    maxRetries = 5,
    baseDelay = 1000,
    maxDelay = 30000,
    label = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      if (attempt === maxRetries) break;

      let delay;
      if (status === 429) {
        const retryAfter = err.response?.headers?.['retry-after'];
        delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelay * Math.pow(2, attempt - 1);
      } else if (status && status >= 400 && status < 500 && status !== 429) {
        break;
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      }

      logger.warn(
        `${label} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${err.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

module.exports = { retryWithBackoff };
