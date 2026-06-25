// content: Google Drive → OneDrive
const { register } = require('../../agentRegistry');
const DriveTestDataAgent = require('../../../agents/drive/DriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googledriveToOnedrive');

register('content', 'googledrive', 'onedrive', {
  TestDataAgent: DriveTestDataAgent,
  ValidationAgent,
});
