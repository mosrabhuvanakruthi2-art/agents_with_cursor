// content: Box → OneDrive
const { register } = require('../../agentRegistry');
const BoxTestDataAgent = require('../../../agents/box/BoxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/boxToOnedrive');

register('content', 'box', 'onedrive', {
  TestDataAgent: BoxTestDataAgent,
  ValidationAgent,
});
