// content: Google Shared Drive → SharePoint
//
// The run wizard exposes Shared Drive as its own provider (`googleshareddrive`, labelled
// "Google Shared Drive") separately from My Drive (`googledrive`, "My Drive"), and sends that value
// verbatim as sourceProvider. Without this registration the run fails at agent resolution before any
// validation runs.
//
// Both providers share the same agents: the Drive client reads My Drive and Shared Drives through the
// same API surface, and the validator resolves whichever root the run points at. The documented
// feature scope for this pair lives in
// backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md.
const { register } = require('../../agentRegistry');
const DriveTestDataAgent = require('../../../agents/drive/DriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googledriveToSharepoint');

register('content', 'googleshareddrive', 'sharepoint', {
  TestDataAgent: DriveTestDataAgent,
  ValidationAgent,
});
