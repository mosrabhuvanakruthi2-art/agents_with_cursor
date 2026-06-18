const { BaseAgent } = require('../core/BaseAgent');
// Message product owns its CloudFuze chat client (Nagalakshmi's {auth}-based client),
// kept separate from the mail migrationClient which our refactor changed incompatibly.
const migrationClient = require('../../clients/chatMigrationClient');
const outlookClient = require('../../clients/outlookClient');
const slackClient = require('../../clients/slackClient');
const googleChatClient = require('../../clients/googleChatClient');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const executionService = require('../../services/executionService');

const MAX_POLL_MINUTES = parseInt(process.env.CHAT_MIGRATION_MAX_WAIT_MINUTES || '30', 10);
const POLL_INTERVAL_MS = 60000; // 1 minute between polls
const STABLE_CHECKS_NEEDED = 3; // count must be stable for 3 consecutive polls

/**
 * MessageMigrationAgent — mirrors the email MigrationAgent pattern exactly:
 *
 *   1. Login to CloudFuze (same /mail/login endpoint)
 *   2. Validate CloudFuze subscriber (optional, same validateUser)
 *   3. Trigger CloudFuze chat migration for each selected channel / DM
 *   4. Poll the destination platform every 60 s until message counts stabilize
 *      (or max CHAT_MIGRATION_MAX_WAIT_MINUTES reached)
 *
 * For Teams → Teams: also performs live Graph read + repost as a fallback when
 * the CloudFuze API is unreachable or not configured.
 *
 * Falls back to simulation mode with a clear log message when neither CloudFuze
 * nor destination tokens are configured.
 */
class MessageMigrationAgent extends BaseAgent {
  constructor() {
    super('MessageMigrationAgent');
    this.jobIds = [];
    this.retries = 0;
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const bump = (msg) => {
      executionService.update(context.executionId, { progress: msg });
    };

    const {
      sourceEmail,
      destinationEmail,
      sourcePlatform,
      destinationPlatform,
      messageCombination,
      migrationType,
      channelIds = [],
      dmIds = [],
    } = context;

    const { sourceData } = context.sharedResults || {};
    const seededCount = sourceData?.postsSucceeded || sourceData?.postsAttempted || 0;

    log.info(
      `MessageMigrationAgent — combination=${messageCombination}, ` +
      `${sourceEmail} → ${destinationEmail}, ` +
      `channels=${channelIds.length} dms=${dmIds.length}`
    );

    const targets = [
      ...channelIds.map((id) => ({ kind: 'channel', id })),
      ...dmIds.map((id) => ({ kind: 'dm', id })),
    ];

    // Build CloudFuze reports URL so the frontend can link directly
    const cfBaseUrl = (env.CHAT_MIGRATION_API_URL || env.MIGRATION_API_URL || '').replace(/\/proxyservices\/v1\/?$/, '');
    const combinationCode = getCombinationCode(sourcePlatform, destinationPlatform);
    const cloudFuzeReportsUrl = cfBaseUrl
      ? `${cfBaseUrl}/pages/reports.html${combinationCode ? '#' + combinationCode : ''}`
      : null;

    const results = {
      mode: 'live',
      combination: messageCombination,
      migrationType,
      sourceEmail,
      destinationEmail,
      sourcePlatform,
      destinationPlatform,
      targetsAttempted: targets.length,
      messagesRead: 0,
      messagesMigrated: 0,
      messagesFailed: 0,
      skipped: [],
      errors: [],
      chatMigrationResults: [],
      ownerValidation: null,
      finalStatus: 'COMPLETED',
      cloudFuzeReportsUrl,
    };

    // ── Check if CloudFuze is configured ─────────────────────────────────────
    const migrationApiUrl = env.MIGRATION_API_URL || '';
    const hasApiConfig = migrationApiUrl && migrationApiUrl !== 'http://localhost:8080';
    const hasCreds = !!(env.MIGRATION_API_BEARER_TOKEN || env.MIGRATION_API_BASIC_AUTH || env.MIGRATION_API_KEY);
    const cfConfigured = hasApiConfig && hasCreds;

    // ── Teams → Teams (live Graph read + repost — used as fallback / when no CF) ─
    if (sourcePlatform === 'teams' && destinationPlatform === 'teams') {
      const srcHasToken = outlookClient.hasTeamsToken(sourceEmail);
      const dstHasToken = outlookClient.hasTeamsToken(destinationEmail);

      if (cfConfigured) {
        // Preferred path: use CloudFuze even for T→T
        return await this._runCloudFuzeFlow(context, results, seededCount, targets, bump, log);
      }

      if (srcHasToken && dstHasToken) {
        // Live Graph fallback: read source, post to destination with attribution
        return await this._runTeamsToTeamsLive(context, results, targets, log);
      }

      const missing = [];
      if (!srcHasToken) missing.push(`source "${sourceEmail}"`);
      if (!dstHasToken) missing.push(`destination "${destinationEmail}"`);
      log.warn(`Teams → Teams: missing tokens for ${missing.join(', ')} and CloudFuze not configured — simulation.`);
      results.mode             = 'simulated';
      results.messagesRead     = seededCount;
      results.messagesMigrated = seededCount;
      results.note = `Configure MIGRATION_API_URL + MIGRATION_API_BEARER_TOKEN (CloudFuze) or sign in both accounts via Message Agent to enable live migration.`;
      return { ...results, finalStatus: 'COMPLETED' };
    }

    // ── All other combinations — CloudFuze or simulation ─────────────────────
    if (cfConfigured) {
      return await this._runCloudFuzeFlow(context, results, seededCount, targets, bump, log);
    }

    // Simulation fallback
    log.warn(
      `CloudFuze not configured (MIGRATION_API_URL=${migrationApiUrl}, no auth token). ` +
      `Running in simulation mode. Set MIGRATION_API_URL + MIGRATION_API_BEARER_TOKEN to enable live migration.`
    );
    results.mode             = 'simulated';
    results.messagesRead     = seededCount;
    results.messagesMigrated = seededCount;
    results.note =
      `${seededCount} message(s) seeded to source "${sourcePlatform}". ` +
      `Live migration requires: MIGRATION_API_URL, MIGRATION_API_BEARER_TOKEN (or MIGRATION_API_KEY) in .env. ` +
      `Set CHAT_MIGRATION_API_INITIATE_PATH if the default paths (chat/move/initiate, etc.) are incorrect.`;
    return { ...results, finalStatus: 'COMPLETED' };
  }

  // ── Full CloudFuze flow (login → validate → initiate → poll) ─────────────

  async _runCloudFuzeFlow(context, results, seededCount, targets, bump, log) {
    const { sourceEmail, destinationEmail, messageCombination } = context;

    // Step 1: Login
    bump(`MessageMigrationAgent: signing in to CloudFuze API…`);
    log.info('Logging into CloudFuze…');
    await migrationClient.login();
    log.info('CloudFuze login successful');

    // Step 1b: Pre-flight — confirm the source/destination platforms are connected
    // as clouds in CloudFuze. Fail fast with a clear message instead of a raw 500.
    bump(`MessageMigrationAgent: checking CloudFuze cloud connections…`);
    const preflight = await migrationClient.preflightClouds(context);
    if (!preflight.ok) {
      log.error(`CloudFuze pre-flight failed: ${preflight.reason}`);
      results.mode = 'live';
      results.messagesFailed = targets.length;
      results.note = `Migration not started — ${preflight.reason}`;
      results.preflight = preflight;
      bump(`MessageMigrationAgent: blocked — ${preflight.reason}`);
      return { ...results, finalStatus: 'FAILED' };
    }
    log.info(
      `CloudFuze pre-flight OK — source ${preflight.srcCloudName}=${preflight.srcCloud?.id} `
      + `(${preflight.srcCloud?.emailId}), dest ${preflight.dstCloudName}=${preflight.dstCloud?.id} (${preflight.dstCloud?.emailId})`
    );

    // Step 2: Validate subscriber (optional — skip on server errors)
    if (process.env.CLOUDFUZE_SKIP_VALIDATE_USER !== 'true') {
      const ownerEmail = env.CLOUDFUZE_OWNER_EMAIL || sourceEmail;
      bump(`MessageMigrationAgent: validating subscriber ${ownerEmail}…`);
      log.info(`Validating CloudFuze subscriber: ${ownerEmail}`);
      try {
        const profile = await migrationClient.validateUser(ownerEmail);
        if (profile?.enabled === false) throw new Error(`CloudFuze user disabled: ${ownerEmail}`);
        if (profile?.isActive === false) throw new Error(`CloudFuze user not active: ${ownerEmail}`);
        results.ownerValidation = {
          userName: profile?.userName || ownerEmail,
          id: profile?.id,
          role: profile?.role,
        };
        log.info(`CloudFuze user OK: ${results.ownerValidation.userName} (id=${results.ownerValidation.id})`);
      } catch (err) {
        const status = err.response?.status;
        if (status >= 500) {
          results.ownerValidation = { skipped: true, reason: `validateUser returned HTTP ${status}` };
          log.warn(`validateUser unavailable (${status}) — continuing with initiate.`);
          bump('MessageMigrationAgent: validateUser unavailable — continuing…');
        } else {
          throw err;
        }
      }
    }

    // Step 3: Trigger CloudFuze chat migration for each selected channel/DM
    bump(`MessageMigrationAgent: triggering chat migration ${sourceEmail} → ${destinationEmail} (${targets.length} targets)…`);
    log.info(`Triggering chat migration: ${messageCombination}, ${targets.length} target(s)`);

    try {
      const apiResult = await migrationClient.triggerChatMigration(context);

      results.chatMigrationResults = apiResult.results || [];
      results.cloudFuzeStatus      = apiResult.status;
      this.jobIds = (apiResult.results || []).filter((r) => r.jobId).map((r) => r.jobId);

      log.info(
        `CloudFuze chat migration initiated — status=${apiResult.status}, ` +
        `initiated=${apiResult.initiated}/${apiResult.totalTargets}, failed=${apiResult.failed}`
      );

      for (const r of apiResult.results) {
        if (r.status === 'INITIATED') {
          log.info(`  ✓ ${r.kind} ${r.target} → job ${r.jobId}`);
        } else {
          log.error(`  ✗ ${r.kind} ${r.target}: ${r.error}`);
          results.errors.push({ target: r.target, error: r.error });
        }
      }

      if (apiResult.status === 'FAILED') {
        results.mode = 'live';
        results.messagesFailed = targets.length;
        results.note = `CloudFuze chat migration failed for all ${targets.length} target(s). `
          + `Likely cause: no registered CloudFuze cloud account for the source/destination platform & email `
          + `(see "no cloud account found" warnings above), or the migration server does not support chat migration. `
          + `Verify the Slack/Teams/Google Chat clouds are connected in the CloudFuze subscriber account.`;
        log.error(results.note);
        return { ...results, finalStatus: 'FAILED' };
      }
    } catch (apiErr) {
      // A genuine API failure (e.g. HTTP 500 from messagemove/create) means NOTHING migrated.
      // Surface it as FAILED rather than masking it as a simulated success.
      log.error(`CloudFuze chat migration API error: ${apiErr.message}`);
      results.mode = 'live';
      results.messagesRead     = 0;
      results.messagesMigrated = 0;
      results.messagesFailed   = targets.length;
      results.errors.push({ target: 'all', error: apiErr.message });
      results.note = `CloudFuze API error: ${apiErr.message}. `
        + `Check the migration server URL/credentials and that the source/destination clouds are registered in CloudFuze.`;
      return { ...results, finalStatus: 'FAILED' };
    }

    const initiatedCount = results.chatMigrationResults.filter((r) => r.status === 'INITIATED').length;

    // When MAX_POLL_MINUTES === 0, skip destination polling and return immediately.
    // The user can monitor progress via CloudFuze Reports.
    if (MAX_POLL_MINUTES === 0) {
      results.messagesRead     = seededCount;
      results.messagesMigrated = seededCount;
      results.mode             = 'live';
      results.note =
        `CloudFuze chat migration initiated for ${initiatedCount} target(s). ` +
        `Monitor progress on CloudFuze Reports — job IDs: ${this.jobIds.join(', ') || '(see below)'}.`;
      bump(`MessageMigrationAgent: migration initiated (${initiatedCount} jobs) — check CloudFuze Reports`);
      return { ...results, finalStatus: 'COMPLETED' };
    }

    // Step 4: Poll destination until message counts stabilize
    bump(
      `MessageMigrationAgent: polling destination every ${POLL_INTERVAL_MS / 1000}s ` +
      `(max ${MAX_POLL_MINUTES} min)…`
    );
    log.info(
      `Polling destination "${context.destinationPlatform}" to detect migration completion ` +
      `(every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_POLL_MINUTES} min)…`
    );

    const finalStatus = await this._pollDestinationUntilStable(context, seededCount, bump, log);

    results.messagesRead     = seededCount;
    results.messagesMigrated = seededCount;
    results.mode             = 'live';
    results.note =
      `CloudFuze chat migration initiated for ${initiatedCount} target(s). ` +
      `Migration status: ${finalStatus}.`;

    bump(`MessageMigrationAgent: finished (${finalStatus})`);
    return { ...results, finalStatus };
  }

  // ── Teams → Teams live Graph fallback ─────────────────────────────────────

  async _runTeamsToTeamsLive(context, results, targets, log) {
    const { sourceEmail, destinationEmail } = context;

    for (const t of targets) {
      try {
        const messages = await outlookClient.readTeamsMessages(sourceEmail, t.id, {
          top: 50,
          sinceMinutes: 240,
        });
        results.messagesRead += messages.length;

        if (messages.length === 0) {
          results.skipped.push({ target: t.id, reason: 'no messages found in source (last 4 h)' });
          continue;
        }

        const sorted = [...messages].sort(
          (a, b) => new Date(a.createdDateTime) - new Date(b.createdDateTime)
        );

        for (const msg of sorted) {
          if (msg.messageType !== 'message') continue;
          if (msg.deletedDateTime) continue;

          const bodyContent = msg.body?.content || '';
          const contentType = msg.body?.contentType === 'html' ? 'html' : 'text';
          const senderName  = msg.from?.user?.displayName || sourceEmail;
          const sentAt      = msg.createdDateTime ? new Date(msg.createdDateTime).toLocaleString() : '';

          const migratedHtml = contentType === 'html'
            ? `<p><em>[Migrated from ${senderName}${sentAt ? ' · ' + sentAt : ''}]</em></p>${bodyContent}`
            : `<p><em>[Migrated from ${senderName}${sentAt ? ' · ' + sentAt : ''}]</em></p><p>${esc(bodyContent)}</p>`;

          try {
            await outlookClient.postTeamsMessage(destinationEmail, t.id, migratedHtml, 'html');
            results.messagesMigrated++;
          } catch (postErr) {
            results.messagesFailed++;
            results.errors.push({ target: t.id, error: postErr.message });
            log.error(`Migration post failed for ${t.id}: ${postErr.message}`);
          }
        }
      } catch (readErr) {
        results.errors.push({ target: t.id, error: readErr.message });
        log.error(`Migration read failed for ${t.id}: ${readErr.message}`);
      }
    }

    log.info(
      `Teams→Teams live done — read=${results.messagesRead} migrated=${results.messagesMigrated} failed=${results.messagesFailed}`
    );
    return results;
  }

  // ── Destination polling (mirrors MigrationAgent._pollDestinationUntilStable) ─

  /**
   * Poll the destination platform for message counts across all selected channels/DMs.
   * Waits until the total count is > 0 and stable for STABLE_CHECKS_NEEDED consecutive
   * polls. Returns 'COMPLETED', 'TIMEOUT', or 'NO_TOKEN'.
   */
  async _pollDestinationUntilStable(context, seededCount, bump, log) {
    const { destinationEmail, destinationPlatform, channelIds, dmIds, executionId } = context;
    const targets = [
      ...(channelIds || []).map((id) => ({ kind: 'channel', id })),
      ...(dmIds     || []).map((id) => ({ kind: 'dm', id })),
    ];

    const maxPolls = Math.ceil((MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS);
    let lastCount  = -1;
    let stableChecks = 0;
    let everSawData  = false;

    // Determine which destination poller to use
    const platform = (destinationPlatform || '').toLowerCase();

    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      this.retries = attempt;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let currentCount = 0;
      try {
        if (platform === 'teams' || platform === 'microsoft') {
          // Count messages in all destination channels (use source IDs for T→T,
          // or fall back to total mail count as a proxy for other combos)
          if (targets.length > 0 && outlookClient.hasTeamsToken(destinationEmail)) {
            for (const t of targets) {
              const msgs = await outlookClient.readTeamsMessages(destinationEmail, t.id, {
                top: 100,
                sinceMinutes: 480,
              });
              currentCount += msgs.length;
            }
          } else {
            // Proxy: total message count in destination mailbox (like email migration)
            currentCount = await outlookClient.getTotalMessageCount(destinationEmail);
          }
        } else if (platform === 'slack') {
          const adminEmail = context.sourceAdminEmail || destinationEmail;
          if (slackClient.hasSlackToken(adminEmail)) {
            for (const t of targets) {
              currentCount += await slackClient.getChannelMessageCount(adminEmail, t.id, 480);
            }
          }
        } else if (platform === 'googlechat') {
          if (googleChatClient.hasGoogleChatToken(destinationEmail)) {
            for (const t of targets) {
              currentCount += await googleChatClient.getSpaceMessageCount(destinationEmail, t.id, 480);
            }
          }
        }
      } catch (err) {
        log.warn(`Poll ${attempt} error: ${err.message}`);
      }

      log.info(
        `Poll ${attempt}/${maxPolls}: destination "${platform}" messages=${currentCount} (prev=${lastCount}, stable=${stableChecks}/${STABLE_CHECKS_NEEDED})`
      );

      if (currentCount > 0) everSawData = true;

      if (currentCount > 0 && currentCount === lastCount) {
        stableChecks++;
        if (stableChecks >= STABLE_CHECKS_NEEDED) {
          log.info(`Chat migration complete — count stable at ${currentCount} for ${stableChecks} consecutive checks`);
          return 'COMPLETED';
        }
        log.info(`Count stable (${stableChecks}/${STABLE_CHECKS_NEEDED})…`);
      } else {
        stableChecks = 0;
      }
      lastCount = currentCount;

      if (executionId) {
        executionService.update(executionId, {
          progress:
            `MessageMigrationAgent: destination "${platform}" messages=${currentCount} ` +
            `(poll ${attempt}/${maxPolls}, stable ${stableChecks}/${STABLE_CHECKS_NEEDED})`,
        });
      }
    }

    log.warn(`Max poll time (${MAX_POLL_MINUTES} min) reached`);
    if (everSawData) {
      log.info('Messages observed in destination — treating as COMPLETED');
      return 'COMPLETED';
    }
    log.warn('No messages appeared in destination within polling window');
    return 'TIMEOUT';
  }

  toJSON() {
    return {
      ...super.toJSON(),
      jobIds:  this.jobIds,
      retries: this.retries,
    };
  }
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CF_COMBINATION_CODES = {
  'slack_teams': 'S2T', 'slack_microsoft': 'S2T', 'slack_microsoft_teams': 'S2T',
  'slack_googlechat': 'S2C', 'slack_google': 'S2C', 'slack_google_chat': 'S2C',
  'slack_slack': 'S2S',
  'teams_teams': 'T2T', 'microsoft_teams_microsoft_teams': 'T2T',
  'teams_googlechat': 'T2C', 'teams_google': 'T2C',
  'teams_slack': 'T2S',
  'googlechat_teams': 'C2T', 'google_teams': 'C2T', 'googlechat_microsoft': 'C2T',
  'googlechat_googlechat': 'C2C', 'google_google': 'C2C',
  'googlechat_slack': 'C2S', 'google_slack': 'C2S',
};

function getCombinationCode(src, dst) {
  if (!src || !dst) return null;
  return CF_COMBINATION_CODES[`${src}_${dst}`] || null;
}

module.exports = MessageMigrationAgent;
