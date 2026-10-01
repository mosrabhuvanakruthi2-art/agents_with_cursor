/**
 * A Google rate limit arrives as HTTP 403, not 429 — and must be retried.
 *
 * `retryWithBackoff` treated every 4xx except 429 as permanent, so a throttled call was abandoned
 * on its FIRST failure with no backoff. Google does not use 429 for per-user quota: it answers 403
 * with reason `userRateLimitExceeded` and the message "User rate limit exceeded."
 *
 * Measured on run ef3c6344, seeding a Shared Drive after a day of repeated runs:
 *
 *   [DriveTestDataAgent]   Failed: qa_notes.txt      — User rate limit exceeded.
 *   [DriveTestDataAgent]   Failed: qa_employees.csv  — User rate limit exceeded.
 *   ... nine more, one second apart
 *
 * DriveTestDataAgent logs upload failures as warnings and continues, so that run seeded 3 files
 * instead of 47 — and the validator then reported "5 pass, 0 fail" because a feature with no data
 * is honestly not assessed. A clean-looking report from a seed that never happened is the worst
 * outcome a QA tool can produce, which is why this belongs in the retry layer and not in a caller.
 *
 * The rule has to stay narrow. `retryWithBackoff` wraps every outbound call in this repo, and a
 * genuine permission denial must still fail immediately — that is what made the OneDrive
 * `Files.ReadWrite.All` gap diagnosable in one call instead of five slow ones.
 */
const assert = require('assert');
const { retryWithBackoff } = require('../src/utils/retry');

/** An axios-shaped error, the way googleapis surfaces one. */
function apiError(status, reason, message) {
  return Object.assign(new Error(message), {
    response: {
      status,
      headers: {},
      data: { error: { errors: reason ? [{ reason }] : [], message } },
    },
  });
}

(async () => {
  // ── A 403 carrying a rate-limit reason is retried ────────────────────────────────────
  {
    let attempts = 0;
    const result = await retryWithBackoff(async () => {
      attempts += 1;
      if (attempts < 3) throw apiError(403, 'userRateLimitExceeded', 'User rate limit exceeded.');
      return 'uploaded';
    }, { maxRetries: 5, maxDelay: 20, label: 'throttled upload' });
    assert.strictEqual(result, 'uploaded', 'the call eventually succeeds');
    assert.strictEqual(attempts, 3,
      'a 403 rate limit is retried — abandoning it on the first failure is what produced a '
      + '3-file source tree on run ef3c6344');
  }

  // The other spellings Google uses for the same condition.
  for (const [reason, message] of [
    ['rateLimitExceeded', 'Rate Limit Exceeded'],
    [null, 'Quota exceeded for quota metric'],
    ['userRateLimitExceeded', 'User rate limit exceeded.'],
  ]) {
    let attempts = 0;
    await retryWithBackoff(async () => {
      attempts += 1;
      if (attempts < 2) throw apiError(403, reason, message);
      return 'ok';
    }, { maxRetries: 3, maxDelay: 20 });
    assert.strictEqual(attempts, 2, `"${message}" must be treated as retryable`);
  }

  // ── A real 403 still fails on the first attempt ──────────────────────────────────────
  {
    let attempts = 0;
    await assert.rejects(() => retryWithBackoff(async () => {
      attempts += 1;
      throw apiError(403, 'insufficientFilePermissions',
        'The user does not have sufficient permissions for this file.');
    }, { maxRetries: 5, maxDelay: 20 }));
    assert.strictEqual(attempts, 1,
      'a permission denial is permanent; retrying it hides the cause and wastes the window');
  }

  // ── Other 4xx are unchanged ──────────────────────────────────────────────────────────
  for (const status of [400, 401, 404, 409]) {
    let attempts = 0;
    await assert.rejects(() => retryWithBackoff(async () => {
      attempts += 1;
      throw apiError(status, null, `http ${status}`);
    }, { maxRetries: 4, maxDelay: 20 }));
    assert.strictEqual(attempts, 1, `${status} must still fail fast`);
  }

  // ── 429 keeps its Retry-After handling ───────────────────────────────────────────────
  {
    let attempts = 0;
    const err = apiError(429, 'rateLimitExceeded', 'Too Many Requests');
    err.response.headers['retry-after'] = '0';
    await retryWithBackoff(async () => {
      attempts += 1;
      if (attempts < 2) throw err;
      return 'ok';
    }, { maxRetries: 3, maxDelay: 20 });
    assert.strictEqual(attempts, 2, '429 behaviour is unchanged');
  }

  // ── 5xx and network errors are still retried ─────────────────────────────────────────
  {
    let attempts = 0;
    await retryWithBackoff(async () => {
      attempts += 1;
      if (attempts < 2) throw apiError(503, null, 'Service Unavailable');
      return 'ok';
    }, { maxRetries: 3, maxDelay: 20 });
    assert.strictEqual(attempts, 2, '5xx is retried as before');

    let netAttempts = 0;
    await retryWithBackoff(async () => {
      netAttempts += 1;
      if (netAttempts < 2) throw new Error('socket hang up');
      return 'ok';
    }, { maxRetries: 3, maxDelay: 20 });
    assert.strictEqual(netAttempts, 2, 'an error with no response is retried as before');
  }

  console.log('retryRateLimit: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
