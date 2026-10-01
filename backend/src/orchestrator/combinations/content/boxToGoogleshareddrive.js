// content: Box → Google Shared Drive
//
// The run wizard exposes Shared Drive as its own provider (`googleshareddrive`, labelled
// "Google Shared Drive") separately from My Drive (`googledrive`), on both the source and the
// destination side (frontend/src/components/runwizard/domains.js sets destProviders to the same
// CONTENT_SERVICES list). It sends that value verbatim as destinationProvider, so without this
// registration a run fails at agent resolution before any validation runs.
//
// Both destinations share the same agents, mirroring how dropboxToGoogleshareddrive.js reuses the
// dropboxToGoogledrive validator on the source side. The Box source is identical — same client, same
// seeded tree — and GoogleDriveValidationAgent.resolveDestinationRoot() already branches on
// destinationProvider === 'googleshareddrive', resolving the drive by name and using its id as the
// root folder id. Nothing about reading a Shared Drive destination is new code.
//
// Known limitation, stated rather than hidden: the reused validator hardcodes
// COMBINATION = 'box_to_googledrive', so a Shared Drive run reports that label and reads that
// combination's tolerance bands and role map. The role map (validation/roleMaps/box_to_google.js)
// already lists both pair ids in its `combinations` array — the same arrangement dropbox_to_google.js
// uses for its own two destinations. Splitting the label is a change to the My Drive combination's own
// file and belongs to that combination's owner, not here.
//
// Feature scope for the pair: backend/data/feature-scope/box-to-google-inscope.md and -outscope.md —
// both already documented as covering "Box to Google (My Drive & Shared Drive)". The destination
// Shared Drive is chosen per run, by name, and must exist before the run starts —
// resolveDestinationRoot throws with the available drives listed when it does not.
const { register } = require('../../agentRegistry');
const BoxToGoogledriveTestDataAgent = require('../../../agents/box/BoxToGoogledriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/boxToGoogledrive');

register('content', 'box', 'googleshareddrive', {
  TestDataAgent: BoxToGoogledriveTestDataAgent,
  ValidationAgent,
});
