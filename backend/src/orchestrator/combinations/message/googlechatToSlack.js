// message: Google Chat → Slack
const { register } = require('../../agentRegistry');
const MessageTestDataAgent = require('../../../agents/message/MessageTestDataAgent');
const MessageMigrationAgent = require('../../../agents/message/MessageMigrationAgent');
const MessageValidationAgent = require('../../../agents/message/MessageValidationAgent');

// Per-combination registration, mirroring combinations/mail and combinations/content.
// Combinations currently share the generic message agents (Nagalakshmi's migration
// logic, which branches per platform internally). Split into combination-specific
// agents here if/when behaviour needs to diverge — no edit to the orchestrator.
register('message', 'googlechat', 'slack', {
  TestDataAgent: MessageTestDataAgent,
  MigrationAgent: MessageMigrationAgent,
  ValidationAgent: MessageValidationAgent,
});
