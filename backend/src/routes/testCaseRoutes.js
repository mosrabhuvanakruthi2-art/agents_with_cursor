const express = require('express');
const router = express.Router();
const {
  generateTestCases,
  getCustomTestCases,
  addCustomTestCase,
  addBulkTestCases,
  deleteCustomTestCase,
  updateCustomTestCase,
} = require('../controllers/testCaseController');

router.post('/generate', generateTestCases);
router.get('/custom', getCustomTestCases);
router.post('/custom', addCustomTestCase);
router.post('/custom/bulk', addBulkTestCases);
router.put('/custom/:id', updateCustomTestCase);
router.delete('/custom/:id', deleteCustomTestCase);

module.exports = router;
