const { BaseAgent } = require('../core/BaseAgent');
const logger = require('../../utils/logger');

/**
 * Produces a validationSummary comparing seeded (source) vs migrated
 * (destination) messages. Includes per-target breakdown, CloudFuze job IDs,
 * and mismatches for the PDF report.
 */
class MessageValidationAgent extends BaseAgent {
  constructor() {
    super('MessageValidationAgent');
  }

  async execute(context) {
    const log = logger.child({ agent: this.name, executionId: context.executionId });

    const { sourceData, migrationResult } = context.sharedResults || {};
    const seed      = sourceData      || {};
    const migration = migrationResult || {};

    log.info(
      `Validating — combination=${context.messageCombination}, ` +
      `channels=${context.channelIds?.length || 0}, dms=${context.dmIds?.length || 0}`
    );

    const mismatches = [];

    // 1. Test data must exist
    if ((seed.totalCases || 0) === 0) {
      mismatches.push({
        category: 'TestData',
        field:    'agentRepo.messageCases',
        expected: '>= 1 test case with productType="message"',
        actual:   '0 matching cases — add cases in Test Case Generator → Agent Repo',
      });
    }

    // 2. At least one target
    if ((seed.totalTargets || 0) === 0) {
      mismatches.push({
        category: 'Scope',
        field:    'channelIds + dmIds',
        expected: 'at least one channel or DM',
        actual:   '0 targets supplied',
      });
    }

    // 3. Seed posting failures
    const seedFailed = seed.postsFailed || 0;
    if (seedFailed > 0) {
      mismatches.push({
        category: 'Seeding',
        field:    'posts.failed',
        expected: '0 failures',
        actual:   `${seedFailed} post(s) failed — check platform token and target IDs`,
      });
    }

    // 4. Dry-run warning
    const hasSeedData = (seed.postsAttempted || 0) > 0;
    const isDryRun    = hasSeedData && !(seed.livePosting || seed.liveSlackPosting);
    if (isDryRun) {
      mismatches.push({
        category: 'Seeding',
        field:    'posts.mode',
        expected: 'live posting',
        actual:
          `dry-run — sign in "${context.sourceEmail}" via Message Agent → Step 1 ` +
          `(Microsoft, Slack, or Google tab depending on source platform)`,
      });
    }

    // 5. Migration must complete
    if (migration.finalStatus && migration.finalStatus !== 'COMPLETED') {
      mismatches.push({
        category: 'Migration',
        field:    'status',
        expected: 'COMPLETED',
        actual:   String(migration.finalStatus),
      });
    }

    // 6. CloudFuze API partial/failed
    if (migration.cloudFuzeStatus === 'PARTIAL') {
      const failed = (migration.chatMigrationResults || []).filter((r) => r.status === 'FAILED');
      mismatches.push({
        category: 'Migration',
        field:    'cloudfuze.targets',
        expected: `all ${migration.targetsAttempted} target(s) initiated`,
        actual:   `${failed.length} target(s) failed: ${failed.map((r) => r.target).join(', ')}`,
      });
    }

    if (migration.cloudFuzeStatus === 'FAILED') {
      mismatches.push({
        category: 'Migration',
        field:    'cloudfuze.status',
        expected: 'INITIATED',
        actual:   'FAILED — check MIGRATION_API_URL, credentials, and network connectivity',
      });
    }

    // 7. Messages migrated vs seeded
    const seededOk  = seed.postsSucceeded || 0;
    const migrated  = migration.messagesMigrated || 0;
    const migMode   = migration.mode || 'simulated';
    if (seededOk > 0 && migrated === 0 && migMode !== 'simulated') {
      mismatches.push({
        category: 'Migration',
        field:    'messages.migrated',
        expected: `>= ${seededOk}`,
        actual:   '0 — source messages could not be read (check read permissions)',
      });
    }

    // ── Per-target breakdown ───────────────────────────────────────────────────
    const allTargetIds = [
      ...(context.channelIds || []).map((id) => ({ id, kind: 'channel' })),
      ...(context.dmIds      || []).map((id) => ({ id, kind: 'dm' })),
    ];

    const totalCasesForTarget = seed.totalCases || 0;

    const perTarget = allTargetIds.map(({ id, kind }) => {
      // Seeding
      const seedErrors   = (seed.errors   || []).filter((e) => e.target === id);
      const seedSkipped  = (seed.skipped  || []).filter((s) => s.target === id);
      const seedFailed   = seedErrors.length;
      const seedSucceeded = isDryRun
        ? 0
        : Math.max(0, totalCasesForTarget - seedFailed);

      // Migration (CloudFuze per-target if available)
      const cfResult = (migration.chatMigrationResults || []).find((r) => r.target === id);
      const migrationStatus = cfResult
        ? cfResult.status
        : (migMode === 'simulated' ? 'SIMULATED' : 'INITIATED');
      const jobId = cfResult?.jobId || null;

      // Validation: seeded vs migrated (count-level)
      let targetStatus = 'PASS';
      const targetIssues = [];

      if (isDryRun) {
        targetStatus = 'DRY-RUN';
      } else if (seedFailed > 0) {
        targetStatus = 'PARTIAL';
        targetIssues.push(`${seedFailed} message(s) failed to post`);
      }
      if (migrationStatus === 'FAILED') {
        targetStatus = 'FAIL';
        targetIssues.push(cfResult?.error || 'migration failed');
      }

      return {
        id,
        kind,
        seeding: {
          attempted:  totalCasesForTarget,
          succeeded:  isDryRun ? 0 : seedSucceeded,
          failed:     seedFailed,
          skipped:    seedSkipped.length,
          errors:     seedErrors.map((e) => e.error),
          isDryRun,
        },
        migration: {
          status:     migrationStatus,
          jobId,
          mode:       migMode,
        },
        status:   targetStatus,
        issues:   targetIssues,
      };
    });

    // Overall: ignore dry-run-only mismatches for status
    const hardMismatches = mismatches.filter(
      (m) => !(m.category === 'Seeding' && m.field === 'posts.mode')
    );
    const overallStatus = hardMismatches.length === 0 ? 'PASSED' : 'MISMATCH';

    log.info(`Validation overall=${overallStatus}, mismatches=${mismatches.length}`);

    return {
      overallStatus,
      combination:         context.messageCombination,
      sourcePlatform:      context.sourcePlatform,
      destinationPlatform: context.destinationPlatform,
      testType:            context.testType,
      migrationMode:       migMode,
      isDryRun,
      counts: {
        testCases:        seed.totalCases           || 0,
        targets:          seed.totalTargets          || 0,
        postsAttempted:   seed.postsAttempted        || 0,
        postsSucceeded:   seed.postsSucceeded        || 0,
        postsFailed:      seed.postsFailed           || 0,
        messagesRead:     migration.messagesRead     || 0,
        messagesMigrated: migration.messagesMigrated || 0,
        messagesFailed:   migration.messagesFailed   || 0,
        targetsInitiated: (migration.chatMigrationResults || []).filter((r) => r.status === 'INITIATED').length,
        targetsFailed:    (migration.chatMigrationResults || []).filter((r) => r.status === 'FAILED').length,
      },
      migrationNote:          migration.note || null,
      cloudFuzeStatus:        migration.cloudFuzeStatus || null,
      chatMigrationResults:   migration.chatMigrationResults || [],
      perTarget,
      mismatches,
    };
  }
}

module.exports = MessageValidationAgent;
