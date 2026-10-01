const logger = require('./logger');

/**
 * Retries an async function with exponential backoff.
 * Respects Retry-After header on 429 responses.
 */

/**
 * A 403 that is really a rate limit, and therefore worth retrying.
 *
 * GOOGLE DOES NOT USE 429 FOR PER-USER QUOTA. It answers HTTP 403 with reason
 * `userRateLimitExceeded` / `rateLimitExceeded` and the message "User rate limit exceeded." The
 * rule below treated every 4xx except 429 as permanent, so each throttled call was abandoned on
 * its FIRST failure with no backoff at all.
 *
 * Measured on run ef3c6344, seeding a Shared Drive after a day of repeated runs:
 *
 *   [DriveTestDataAgent]   Failed: qa_notes.txt      — User rate limit exceeded.
 *   [DriveTestDataAgent]   Failed: qa_employees.csv  — User rate limit exceeded.
 *   ... nine more, one second apart
 *
 * The seeder logs those as warnings and continues, so the run produced a source tree of 3 files
 * instead of 47 — and then reported "5 pass, 0 fail" because features with no data are honestly
 * not assessed. A clean-looking report from a seed that never happened is the worst possible
 * outcome for a QA tool.
 *
 * Deliberately narrow: a 403 is only retried when it carries a rate-limit reason. A genuine
 * permission denial still fails immediately, which is what made the OneDrive `Files.ReadWrite.All`
 * gap diagnosable rather than a five-attempt hang.
 */
function isRateLimit403(err) {
  if (err?.response?.status !== 403) return false;
  const body = err.response?.data;
  const reasons = [];
  const collect = (e) => { if (e && e.reason) reasons.push(String(e.reason)); };
  if (Array.isArray(body?.error?.errors)) body.error.errors.forEach(collect);
  if (body?.error?.status) reasons.push(String(body.error.status));
  const haystack = `${reasons.join(' ')} ${err.message || ''} ${body?.error?.message || ''}`
    .toLowerCase();
  return /ratelimitexceeded|user rate limit|quota ?exceeded|too many requests|backenderror/
    .test(haystack);
}
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
      const rateLimited = status === 429 || isRateLimit403(err);
      if (rateLimited) {
        const retryAfter = err.response?.headers?.['retry-after'];
        // Longer floor than the generic backoff: a per-user quota does not clear in a second, and
        // retrying too eagerly is what keeps the bucket empty. 2s, 4s, 8s, 16s, capped at maxDelay.
        delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(2000 * Math.pow(2, attempt - 1), maxDelay);
      } else if (status && status >= 400 && status < 500) {
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
