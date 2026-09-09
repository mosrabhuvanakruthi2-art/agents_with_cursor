// content: Google Drive → SharePoint
const { register } = require('../../agentRegistry');
const DriveTestDataAgent = require('../../../agents/drive/DriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googledriveToSharepoint');

register('content', 'googledrive', 'sharepoint', {
  TestDataAgent: DriveTestDataAgent,
  ValidationAgent,
});
