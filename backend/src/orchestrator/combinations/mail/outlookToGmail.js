// mail: Outlook (microsoft) → Gmail (google)
const { register } = require('../../agentRegistry');
const OutlookTestDataAgent = require('../../../agents/outlook/OutlookTestDataAgent');
const GmailValidationAgent = require('../../../agents/gmail/GmailValidationAgent');

register('mail', 'microsoft', 'google', {
  TestDataAgent: OutlookTestDataAgent,
  ValidationAgent: GmailValidationAgent,
});
