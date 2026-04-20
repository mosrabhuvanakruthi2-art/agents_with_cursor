const express = require('express');
const router = express.Router();
const controller = require('../controllers/testRepositoryController');
const localController = require('../controllers/localRepoController');

router.post('/import', controller.importRepository);
/** Pull Test Repository from Jira/Xray into MongoDB (and JSON) — same handler as /import */
router.post('/sync', controller.syncFromXray);
router.post('/clear', controller.clearRepository);
router.get('/data', controller.getData);
router.get('/status', controller.getStatus);
router.get('/defaults', controller.getDefaults);
router.get('/test-detail', controller.getTestDetail);

// Local (user-created) folders and test cases
router.get('/local', localController.getLocalData);
router.post('/local/folders', localController.createFolder);
router.delete('/local/folders/:id', localController.deleteFolder);
router.post('/local/tests', localController.createTest);
router.delete('/local/tests/:id', localController.deleteTest);

module.exports = router;
