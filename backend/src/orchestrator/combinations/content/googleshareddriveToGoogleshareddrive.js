// content: Google Shared Drive → Google Shared Drive
//
// The run wizard exposes Shared Drive as its own provider (`googleshareddrive`, labelled
// "Google Shared Drive") separately from My Drive (`googledrive`), on BOTH the source and the
// destination side (frontend/src/components/runwizard/domains.js uses the same CONTENT_SERVICES
// list for each). It sends that value verbatim, so without this registration a run fails at agent
// resolution before anything is seeded.
//
// The source is seeded by DriveTestDataAgent — the same agent every other Drive pair uses; it
// resolves the Shared Drive by name from `sourceSharedDriveName`, falling back to
// GOOGLE_SHARED_DRIVE_NAME. The destination half is the shared GoogleDriveValidationAgent, whose
// resolveDestinationRoot() already branches on `googleshareddrive` and resolves the drive by name.
// So for this pair BOTH sides are read through the same code and cannot drift apart in what they
// believe a permission, a revision or a link is.
//
// Feature scope:
//   backend/data/feature-scope/google-shared-drive-to-shared-drive-inscope.md   (19 features)
//   backend/data/feature-scope/google-shared-drive-to-shared-drive-outscope.md  (7 limitations)
//
// Notes for whoever runs it:
//   • BOTH Shared Drives must already EXIST — a Shared Drive cannot be created by a path, and the
//     validator throws with the available drives listed rather than validating the wrong tree.
//   • Both accounts must be readable by THIS tool (a stored OAuth token, or Domain-Wide Delegation
//     authorised for the domain) and both must be registered as GOOGLE_SHARED_DRIVES clouds on the
//     CloudFuze server.
//   • The destination is read as the MAPPED destination user from Map Users, not as the admin
//     picked in step 1.
const { register } = require('../../agentRegistry');
const DriveTestDataAgent = require('../../../agents/drive/DriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googleshareddriveToGoogleshareddrive');

register('content', 'googleshareddrive', 'googleshareddrive', {
  TestDataAgent: DriveTestDataAgent,
  ValidationAgent,
});
