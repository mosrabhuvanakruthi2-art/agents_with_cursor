// mail: Outlook (microsoft) → Outlook (microsoft)
const { register } = require('../../agentRegistry');
const OutlookTestDataAgent = require('../../../agents/outlook/OutlookTestDataAgent');
const OutlookValidationAgent = require('../../../agents/outlook/OutlookValidationAgent');

register('mail', 'microsoft', 'microsoft', {
  TestDataAgent: OutlookTestDataAgent,
  ValidationAgent: OutlookValidationAgent,
});
