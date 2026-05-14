const { v4: uuidv4 } = require('uuid');

const TEST_TYPES = { SMOKE: 'SMOKE', SANITY: 'SANITY', E2E: 'E2E' };

class MigrationContext {
  constructor({
    sourceEmail,
    destinationEmail,
    migrationType = 'FULL',
    includeMail,
    includeCalendar,
    includeContacts,
    testType = 'E2E',
    executionId,
    sourceProvider = 'google',
    destinationProvider = 'microsoft',
    /** @type {{ sourceEmail: string, destinationEmail: string }[]} Optional source→destination user pairs for deep mail To/Cc/Bcc expectations */
    userEmailMappings = [],
    /**
     * Gmail→Outlook mapping option. When true, messages that live ONLY in Gmail "All Mail" (no
     * labels, not in Inbox/Sent/Custom) are expected to land in an Outlook "Archive" folder.
     * When false (CloudFuze default), those messages are expected to be skipped by migration.
     */
    migrateOrphanedLabels = false,
    /** Admin email for the source cloud account (used by MigrationAgent to identify sourceCloudId) */
    sourceAdminEmail = '',
    /** Admin email for the destination cloud account (used by MigrationAgent to identify destCloudId) */
    destAdminEmail = '',
    /** CloudFuze migration server base URL (e.g. https://newtestemail5.cloudfuze.com) */
    migrationServerUrl = '',
    /** App account email for the migration server */
    migrationServerEmail = '',
    /** App account password for the migration server */
    migrationServerPassword = '',
  }) {
    this.sourceEmail = sourceEmail;
    this.destinationEmail = destinationEmail;

    const mt = String(migrationType || 'FULL').toUpperCase();
    this.migrationType = ['FULL', 'DELTA'].includes(mt) ? mt : 'FULL';

    // One-time (FULL): mail + labels/folders. Delta: incremental mail + labels + contacts + calendars.
    this.includeMail = includeMail !== false;

    if (includeCalendar !== undefined) {
      this.includeCalendar = Boolean(includeCalendar);
    } else {
      this.includeCalendar = this.migrationType === 'DELTA';
    }

    if (includeContacts !== undefined) {
      this.includeContacts = Boolean(includeContacts);
    } else {
      this.includeContacts = this.migrationType === 'DELTA';
    }

    const tt = String(testType || '').toUpperCase();
    this.deepValidation = true;

    this.testType =
      tt === 'DEEP_E2E'
        ? TEST_TYPES.E2E
        : TEST_TYPES[tt] || TEST_TYPES.E2E;
    this.executionId = executionId || uuidv4();
    this.sourceProvider = sourceProvider || 'google';
    this.destinationProvider = destinationProvider || 'microsoft';
    this.userEmailMappings = Array.isArray(userEmailMappings) ? userEmailMappings : [];
    this.migrateOrphanedLabels = Boolean(migrateOrphanedLabels);
    this.sourceAdminEmail = String(sourceAdminEmail || '').trim().toLowerCase();
    this.destAdminEmail = String(destAdminEmail || '').trim().toLowerCase();
    this.migrationServerUrl = String(migrationServerUrl || '').trim().replace(/\/$/, '');
    this.migrationServerEmail = String(migrationServerEmail || '').trim();
    this.migrationServerPassword = String(migrationServerPassword || '');
  }

  validate() {
    const errors = [];
    if (!this.sourceEmail) errors.push('sourceEmail is required');
    if (!this.destinationEmail) errors.push('destinationEmail is required');
    if (!['FULL', 'DELTA'].includes(this.migrationType)) {
      errors.push('migrationType must be FULL or DELTA');
    }
    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  toJSON() {
    return {
      sourceEmail: this.sourceEmail,
      destinationEmail: this.destinationEmail,
      migrationType: this.migrationType,
      includeMail: this.includeMail,
      includeCalendar: this.includeCalendar,
      includeContacts: this.includeContacts,
      testType: this.testType,
      executionId: this.executionId,
      sourceProvider: this.sourceProvider,
      destinationProvider: this.destinationProvider,
      deepValidation: this.deepValidation,
      userEmailMappings: this.userEmailMappings,
      migrateOrphanedLabels: this.migrateOrphanedLabels,
      sourceAdminEmail: this.sourceAdminEmail,
      destAdminEmail: this.destAdminEmail,
      migrationServerUrl: this.migrationServerUrl || undefined,
      migrationServerEmail: this.migrationServerEmail || undefined,
      preMigrationSnapshot: this.preMigrationSnapshot || undefined,
      preMigrationDestSnapshot: this.preMigrationDestSnapshot || undefined,
    };
  }
}

MigrationContext.TEST_TYPES = TEST_TYPES;

module.exports = MigrationContext;
