// content: Dropbox → Google Shared Drive
//
// The run wizard exposes Shared Drive as its own provider (`googleshareddrive`, labelled
// "Google Shared Drive") separately from My Drive (`googledrive`), on both the source and the
// destination side (frontend/src/components/runwizard/domains.js sets destProviders to the same
// CONTENT_SERVICES list). It sends that value verbatim as destinationProvider, so without this
// registration a run fails at agent resolution before any validation runs.
//
// Both destinations share the same agents, mirroring how googleshareddriveToSharepoint reuses the
// googledriveToSharepoint validator on the source side. The Dropbox source is identical — same
// client, same seeded tree — and GoogleDriveValidationAgent.resolveDestinationRoot() already
// branches on destinationProvider === 'googleshareddrive', resolving the drive by name and using
// its id as the root folder id. Nothing about reading a Shared Drive destination is new code.
//
// Known limitation, stated rather than hidden: the reused validator hardcodes
// COMBINATION = 'dropbox_to_googledrive', so a Shared Drive run reports that label and reads that
// combination's tolerance bands and role map. Adding utils/contentTolerance/
// dropboxToGoogleshareddrive.js would be dead code — nothing would ever look it up. The sibling
// pair has the same property today (googleshareddrive → sharepoint runs report
// sourceProvider 'googledrive'). Splitting the label is a change to the My Drive combination's own
// file and belongs to that combination's owner, not here.
//
// Feature scope for the pair: backend/data/feature-scope/dropbox-to-google-inscope.md and
// -outscope.md. The destination Shared Drive is chosen per run, by name, and must exist before the
// run starts — resolveDestinationRoot throws with the available drives listed when it does not.
const { register } = require('../../agentRegistry');
const DropboxTestDataAgent = require('../../../agents/dropbox/DropboxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/dropboxToGoogledrive');

register('content', 'dropbox', 'googleshareddrive', {
  TestDataAgent: DropboxTestDataAgent,
  ValidationAgent,
});
