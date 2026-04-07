const { v4: uuidv4 } = require('uuid');

const TEST_TYPES = { SMOKE: 'SMOKE', SANITY: 'SANITY', E2E: 'E2E' };

class MigrationContext {
  constructor({
    sourceEmail,
    destinationEmail,
    migrationType = 'FULL',
    includeMail = true,
    includeCalendar = true,
    testType = 'E2E',
    executionId,
  }) {
    this.sourceEmail = sourceEmail;
    this.destinationEmail = destinationEmail;
    this.migrationType = migrationType;
    this.includeMail = includeMail;
    this.includeCalendar = includeCalendar;
    this.testType = TEST_TYPES[testType] || TEST_TYPES.E2E;
    this.executionId = executionId || uuidv4();
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
      testType: this.testType,
      executionId: this.executionId,
    };
  }
}

MigrationContext.TEST_TYPES = TEST_TYPES;

module.exports = MigrationContext;
