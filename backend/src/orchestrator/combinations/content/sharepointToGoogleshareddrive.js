// content: SharePoint Online → Google Shared Drive
//
// The run wizard already offers both sides (frontend/src/components/runwizard/domains.js lists
// `sharepoint` and `googleshareddrive` in CONTENT_SERVICES, as source AND destination) and sends
// those values verbatim. Without this registration the run fails at agent resolution before any
// data is seeded or validated.
//
// This is the first combination with SharePoint as the SOURCE, so it is also the first to need a
// SharePoint seeder — agents/sharepoint/SharePointTestDataAgent.js. The destination half is shared
// with the Dropbox → Google pairs through GoogleDriveValidationAgent, which the validator extends.
//
// Feature scope:
//   backend/data/feature-scope/sharepoint-to-google-shared-drive-inscope.md   (17 features)
//   backend/data/feature-scope/sharepoint-to-google-shared-drive-outscope.md  (13 limitations)
//
// The destination Shared Drive is chosen per run, BY NAME, and must exist before the run starts:
// GoogleDriveValidationAgent.resolveDestinationRoot reads it from the run's destination path (its
// first segment), destinationSharedDriveName, or GOOGLE_DEST_SHARED_DRIVE_NAME, and throws with
// the available drives listed when none of them resolves.
const { register } = require('../../agentRegistry');
const SharePointTestDataAgent = require('../../../agents/sharepoint/SharePointTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/sharepointToGoogleshareddrive');

register('content', 'sharepoint', 'googleshareddrive', {
  TestDataAgent: SharePointTestDataAgent,
  ValidationAgent,
});
