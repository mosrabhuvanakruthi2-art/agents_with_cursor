// mail: Gmail (google) → Outlook (microsoft)
const { register } = require('../../agentRegistry');
const GmailTestDataAgent = require('../../../agents/gmail/GmailTestDataAgent');
const OutlookValidationAgent = require('../../../agents/outlook/OutlookValidationAgent');

register('mail', 'google', 'microsoft', {
  TestDataAgent: GmailTestDataAgent,
  ValidationAgent: OutlookValidationAgent,
});
