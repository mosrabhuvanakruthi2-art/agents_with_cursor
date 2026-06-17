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
router.post('/clean-source-emails', controller.cleanSourceEmails);
router.post('/clean-source-folders', controller.cleanSourceFolders);
router.post('/clean-source-calendars', controller.cleanSourceCalendars);
router.get('/calendar-event-count', controller.getCalendarEventCount);
router.post('/delete-calendar-events', controller.deleteCalendarEvents);
router.get('/source-calendar-stats', controller.getSourceCalendarStats);
router.post('/delete-source-calendar-events', controller.deleteSourceCalendarEvents);
router.post('/clean-destination-emails', controller.cleanDestinationEmails);
router.post('/clean-destination-folders', controller.cleanDestinationFolders);
router.post('/clean-destination-events', controller.cleanDestinationEvents);
router.post('/create-outlook-data', controller.createOutlookData);
router.post('/create-test-data', controller.createTestData);
router.post('/create-box-data', controller.createBoxData);
router.get('/box/users', controller.getBoxUsers);
router.post('/create-drive-data', controller.createDriveData);
router.post('/update-drive-versions', controller.updateDriveVersions);
router.post('/setup-drive-shared-links', controller.setupDriveSharedLinks);
router.post('/executions/:id/cancel', controller.cancelExecution);

module.exports = router;

