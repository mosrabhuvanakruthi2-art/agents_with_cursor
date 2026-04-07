class ValidationResult {
  constructor() {
    this.mailValidation = {
      sourceCount: 0,
      destinationCount: 0,
      countMatch: false,
      folderMapping: [],
      attachmentChecks: [],
      subjectChecks: [],
    };
    this.calendarValidation = {
      sourceEventCount: 0,
      destinationEventCount: 0,
      countMatch: false,
      recurringEvents: [],
      primaryCalendar: null,
      secondaryCalendars: [],
      eventDetails: [],
    };
    this.sourceData = {
      defaultLabels: [],
      customLabels: [],
    };
    this.destinationData = {
      defaultFolders: [],
      customFolders: [],
    };
    this.comparison = {
      defaultLabelsMatch: false,
      customLabelsMatch: false,
      issues: [],
    };
    this.mismatches = [];
    this.overallStatus = 'PENDING';
  }

  addMismatch(category, field, expected, actual) {
    this.mismatches.push({ category, field, expected, actual });
  }

  addComparisonIssue(type, label, sourceCount, destCount) {
    this.comparison.issues.push({ type, label, sourceCount, destCount });
  }

  computeOverallStatus() {
    if (this.comparison.issues.length > 0) {
      this.mismatches.push(
        ...this.comparison.issues.map((i) => ({
          category: 'comparison',
          field: i.label,
          expected: `${i.sourceCount} (source)`,
          actual: `${i.destCount} (destination)`,
        }))
      );
    }
    this.overallStatus = this.mismatches.length === 0 ? 'PASS' : 'FAIL';
    return this.overallStatus;
  }

  toJSON() {
    return {
      mailValidation: this.mailValidation,
      calendarValidation: this.calendarValidation,
      sourceData: this.sourceData,
      destinationData: this.destinationData,
      comparison: this.comparison,
      mismatches: this.mismatches,
      overallStatus: this.overallStatus,
    };
  }
}

module.exports = ValidationResult;
