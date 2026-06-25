const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');

// Report-only validator for content: Box → OneDrive.
// Edit ONLY this file to add deep file/folder/permission comparison for this combination.
class BoxToOnedriveValidationAgent extends ContentReportValidationAgent {
  constructor() {
    super('BoxToOnedriveValidationAgent');
  }
}

module.exports = BoxToOnedriveValidationAgent;
