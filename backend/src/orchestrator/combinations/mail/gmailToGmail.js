// mail: Gmail (google) → Gmail (google)
const { register } = require('../../agentRegistry');
const GmailTestDataAgent = require('../../../agents/gmail/GmailTestDataAgent');
const GmailToGmailValidationAgent = require('../../../agents/gmail/GmailToGmailValidationAgent');

register('mail', 'google', 'google', {
  TestDataAgent: GmailTestDataAgent,
  ValidationAgent: GmailToGmailValidationAgent,
});
