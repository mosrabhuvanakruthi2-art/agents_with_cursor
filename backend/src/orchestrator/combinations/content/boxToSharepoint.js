// content: Box → SharePoint
const { register } = require('../../agentRegistry');
const BoxTestDataAgent = require('../../../agents/box/BoxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/boxToSharepoint');

register('content', 'box', 'sharepoint', {
  TestDataAgent: BoxTestDataAgent,
  ValidationAgent,
});
