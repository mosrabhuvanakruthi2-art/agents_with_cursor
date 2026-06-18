const ContentReportValidationAgent = require('../../../agents/content/ContentReportValidationAgent');

// Report-only validator for content: Box → SharePoint.
// Edit ONLY this file to add deep file/folder/permission comparison for this combination.
class BoxToSharepointValidationAgent extends ContentReportValidationAgent {
  constructor() {
    super('BoxToSharepointValidationAgent');
  }
}

module.exports = BoxToSharepointValidationAgent;
