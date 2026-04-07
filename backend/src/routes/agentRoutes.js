const express = require('express');
const router = express.Router();
const controller = require('../controllers/agentController');

router.post('/run', controller.runAgents);
router.get('/executions', controller.getExecutions);
router.get('/executions/:id', controller.getExecution);
router.get('/executions/:id/logs', controller.getExecutionLogs);
router.get('/stats', controller.getStats);
router.get('/test-connections', controller.testConnections);
router.get('/users/source', controller.getSourceUsers);
router.get('/users/destination', controller.getDestinationUsers);
router.get('/mailbox-stats', controller.getMailboxStats);
router.get('/executions/:id/pdf', controller.generatePdf);
router.post('/clean-destination', controller.cleanDestination);
router.get('/source-mailbox-stats', controller.getSourceMailboxStats);
router.post('/clean-source', controller.cleanSource);
router.get('/source-mailbox-stats', controller.getSourceMailboxStats);
router.post('/clean-source', controller.cleanSource);

module.exports = router;

