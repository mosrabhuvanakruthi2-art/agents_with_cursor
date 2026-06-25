const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');

// Report-only validator for content: Google Drive → SharePoint.
// Edit ONLY this file to add deep file/folder/permission comparison for this combination.
class GoogledriveToSharepointValidationAgent extends ContentReportValidationAgent {
  constructor() {
    super('GoogledriveToSharepointValidationAgent');
  }
}

module.exports = GoogledriveToSharepointValidationAgent;
