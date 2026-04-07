const { BaseAgent } = require('../core/BaseAgent');
const migrationClient = require('../../clients/migrationClient');
const outlookClient = require('../../clients/outlookClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');

const MAX_POLL_MINUTES = parseInt(process.env.MIGRATION_MAX_WAIT_MINUTES, 10) || 30;
const POLL_INTERVAL_MS = 60000;
const STABLE_CHECKS_NEEDED = 3;

class MigrationAgent extends BaseAgent {
  constructor() {
    super('MigrationAgent');
    this.jobId = null;
    this.retries = 0;
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const bump = (msg) => {
      executionService.update(context.executionId, { progress: msg });
    };

    log.info('Logging into CloudFuze...');
    bump('MigrationAgent: signing in to CloudFuze API…');
    await migrationClient.login();
    log.info('CloudFuze login successful');

    let ownerValidation = null;
    if (process.env.CLOUDFUZE_SKIP_VALIDATE_USER !== 'true') {
      const ownerEmail = env.CLOUDFUZE_OWNER_EMAIL || context.sourceEmail;
      bump(`MigrationAgent: validating subscriber ${ownerEmail}…`);
      log.info(`Validating CloudFuze subscriber (validateUser): ${ownerEmail}`);
      try {
        const profile = await migrationClient.validateUser(ownerEmail);
        if (profile && profile.enabled === false) {
          throw new Error(`CloudFuze user is disabled: ${ownerEmail}`);
        }
        if (profile && profile.isActive === false) {
          throw new Error(`CloudFuze user is not active: ${ownerEmail}`);
        }
        ownerValidation = {
          userName: profile?.userName || ownerEmail,
          id: profile?.id,
          role: profile?.role,
        };
        log.info(
          `CloudFuze user OK: ${ownerValidation.userName} (id=${ownerValidation.id}, role=${ownerValidation.role || 'n/a'})`
        );
      } catch (err) {
        const status = err.response?.status;
        const isServerError = status >= 500 && status < 600;
        if (isServerError) {
          ownerValidation = {
            skipped: true,
            reason: `validateUser returned HTTP ${status} (CloudFuze server error)`,
          };
          log.warn(
            `${ownerValidation.reason} — continuing with move/initiate. Set CLOUDFUZE_SKIP_VALIDATE_USER=true to skip this call entirely.`
          );
          bump('MigrationAgent: validateUser unavailable (server error) — continuing…');
        } else {
          throw err;
        }
      }
    }

    bump(`MigrationAgent: triggering move ${context.sourceEmail} → ${context.destinationEmail}…`);
    log.info(`Triggering migration: ${context.sourceEmail} → ${context.destinationEmail}`);
    const triggerResult = await migrationClient.triggerMigration(context);
    this.jobId = triggerResult.jobId;

    const rawStr = typeof triggerResult.rawResponse === 'string'
      ? triggerResult.rawResponse
      : JSON.stringify(triggerResult.rawResponse);
    log.info(`CloudFuze response: ${rawStr}`);

    bump(
      `MigrationAgent: polling Outlook (${context.destinationEmail}) every ${POLL_INTERVAL_MS / 1000}s (max ${MAX_POLL_MINUTES} min)…`
    );
    log.info(`Polling destination to detect migration completion (every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_POLL_MINUTES} min)...`);
    const finalStatus = await this._pollDestinationUntilStable(
      context.destinationEmail,
      log,
      context.executionId
    );

    bump(`MigrationAgent: finished (${finalStatus})`);
    return {
      jobId: this.jobId,
      finalStatus,
      retriesUsed: this.retries,
      rawResponse: triggerResult.rawResponse,
      ownerValidation,
    };
  }

  /**
   * Poll destination until message count stabilizes (same count for 3 consecutive checks
   * at 60s intervals = 3 minutes of no change, AND count must be > 0).
   * Max wait: 30 minutes by default.
   */
  async _pollDestinationUntilStable(destEmail, log, executionId) {
    const maxPolls = Math.ceil((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);
    let lastCount = -1;
    let stableChecks = 0;
    let everSawData = false;

    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      this.retries = attempt;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        const currentCount = await outlookClient.getTotalMessageCount(destEmail);
        log.info(`Poll ${attempt}/${maxPolls}: destination ${currentCount} messages (prev: ${lastCount})`);

        if (currentCount > 0) everSawData = true;

        // Only consider stable when count > 0 and unchanged for STABLE_CHECKS_NEEDED rounds
        if (currentCount > 0 && currentCount === lastCount) {
          stableChecks++;
          if (stableChecks >= STABLE_CHECKS_NEEDED) {
            log.info(`Migration complete — count stable at ${currentCount} for ${stableChecks} consecutive checks`);
            return 'COMPLETED';
          }
          log.info(`Count stable (${stableChecks}/${STABLE_CHECKS_NEEDED})...`);
        } else {
          stableChecks = 0;
        }

        lastCount = currentCount;

        if (executionId) {
          executionService.update(executionId, {
            progress: `MigrationAgent: Outlook messages ${currentCount} (poll ${attempt}/${maxPolls}, stable streak ${stableChecks}/${STABLE_CHECKS_NEEDED})`,
          });
        }
      } catch (err) {
        log.warn(`Poll ${attempt} error: ${err.message}`);
      }
    }

    log.warn(`Max poll time (${MAX_POLL_MINUTES} min) reached`);
    if (everSawData) {
      log.info('Data was observed in destination — treating as completed');
      return 'COMPLETED';
    }
    log.warn('No data ever appeared in destination — migration may have failed');
    return 'TIMEOUT';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      jobId: this.jobId,
      retries: this.retries,
    };
  }
}

module.exports = MigrationAgent;
