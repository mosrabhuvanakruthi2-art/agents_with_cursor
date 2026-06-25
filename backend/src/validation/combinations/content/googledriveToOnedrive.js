const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');

// Report-only validator for content: Google Drive → OneDrive.
// Edit ONLY this file to add deep file/folder/permission comparison for this combination.
class GoogledriveToOnedriveValidationAgent extends ContentReportValidationAgent {
  constructor() {
    super('GoogledriveToOnedriveValidationAgent');
  }
}

module.exports = GoogledriveToOnedriveValidationAgent;
