const { v4: uuidv4 } = require('uuid');

const TEST_TYPES = { SMOKE: 'SMOKE', SANITY: 'SANITY' };
const MIGRATION_TYPES = { FULL: 'FULL', DELTA: 'DELTA' };

/**
 * Execution context for a Message Agent run. Mirrors MigrationContext so the
 * same executionService / logs / polling pipeline works unchanged.
 *
 * Mail concepts (labels, calendar) are intentionally absent.
 */
class MessageMigrationContext {
  constructor({
    sourceEmail,
    destinationEmail,
    sourceAdminEmail = null,
    migrationType = 'FULL',
    testType = 'SANITY',
    messageCombination = null,
    channelIds = [],
    dmIds = [],
    channelObjects = [],
    dmObjects = [],
    selectedTestCaseIds = [],
    migrationServerUrl = null,
    migrationServerEmail = null,
    migrationServerPassword = null,
    migrationServerBasicAuth = null,
    userMappings = [],
    userMappingCsvPath = null,
    executionId,
  }) {
    this.kind = 'message';
    this.sourceEmail = sourceEmail;
    this.destinationEmail = destinationEmail;
    this.sourceAdminEmail = sourceAdminEmail || null;
    this.migrationType = MIGRATION_TYPES[migrationType] || MIGRATION_TYPES.FULL;
    this.testType = TEST_TYPES[testType] || TEST_TYPES.SANITY;
    this.messageCombination = (messageCombination || '').trim() || null;
    this.channelIds = Array.isArray(channelIds) ? channelIds : [];
    this.dmIds = Array.isArray(dmIds) ? dmIds : [];
    // Enriched channel/DM objects carrying name, type, workSpaceName, etc. for CF migration payload
    this.channelObjects = Array.isArray(channelObjects) ? channelObjects : [];
    this.dmObjects = Array.isArray(dmObjects) ? dmObjects : [];
    this.selectedTestCaseIds = Array.isArray(selectedTestCaseIds) ? selectedTestCaseIds : [];
    // CloudFuze migration-server credentials (from the wizard) — used per-request by the
    // chat client so any server/account works without hardcoded env credentials.
    this.migrationServerUrl = migrationServerUrl || null;
    this.migrationServerEmail = migrationServerEmail || null;
    this.migrationServerPassword = migrationServerPassword || null;
    this.migrationServerBasicAuth = migrationServerBasicAuth || null;
    this.userMappings = Array.isArray(userMappings) ? userMappings : [];
    this.userMappingCsvPath = (typeof userMappingCsvPath === 'string' && userMappingCsvPath.trim()) ? userMappingCsvPath.trim() : null;
    this.executionId = executionId || uuidv4();

    const { sourcePlatform, destinationPlatform } = parseCombination(this.messageCombination);
    this.sourcePlatform = sourcePlatform;
    this.destinationPlatform = destinationPlatform;
  }

  validate() {
    const errors = [];
    if (!this.sourceEmail) errors.push('sourceEmail is required');
    if (!this.destinationEmail) errors.push('destinationEmail is required');
    if (!this.messageCombination) errors.push('messageCombination is required');
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  toJSON() {
    return {
      kind: this.kind,
      sourceEmail: this.sourceEmail,
      destinationEmail: this.destinationEmail,
      sourceAdminEmail: this.sourceAdminEmail,
      migrationType: this.migrationType,
      testType: this.testType,
      messageCombination: this.messageCombination,
      sourcePlatform: this.sourcePlatform,
      destinationPlatform: this.destinationPlatform,
      channelIds: this.channelIds,
      dmIds: this.dmIds,
      channelObjects: this.channelObjects,
      dmObjects: this.dmObjects,
      selectedTestCaseIds: this.selectedTestCaseIds,
      executionId: this.executionId,
    };
  }
}

/** "Slack → Microsoft Teams" → { sourcePlatform: 'slack', destinationPlatform: 'teams' } */
function parseCombination(combo) {
  if (!combo) return { sourcePlatform: null, destinationPlatform: null };
  const [left, right] = combo.split(/→|->/).map((s) => (s || '').trim().toLowerCase());
  return {
    sourcePlatform: normalizePlatform(left),
    destinationPlatform: normalizePlatform(right),
  };
}

function normalizePlatform(label) {
  if (!label) return null;
  if (label.includes('slack')) return 'slack';
  if (label.includes('teams') || label.includes('microsoft')) return 'teams';
  if (label.includes('chat') || label.includes('google')) return 'googlechat';
  return label;
}

MessageMigrationContext.TEST_TYPES = TEST_TYPES;

module.exports = MessageMigrationContext;
