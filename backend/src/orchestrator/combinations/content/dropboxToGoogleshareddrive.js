// content: Dropbox → Google Shared Drive
//
// The run wizard exposes Shared Drive as its own provider (`googleshareddrive`, labelled "Google
// Shared Drive") separately from My Drive (`googledrive`, "My Drive") and sends that value verbatim
// as destinationProvider. Without this registration the run fails at agent resolution before any
// validation runs.
//
// Both destinations share the same agents, the same way googleshareddriveToSharepoint shares
// googledriveToSharepoint's validator:
//   - the scope document is written for My Drive and Shared Drive TOGETHER
//     (backend/data/feature-scope/dropbox-to-google-inscope.md, "Covers both combinations")
//   - the source half is identical — same Dropbox roles, same Paper behaviour, same link audiences
//   - validation/destinations/googledrive.js registers `googleshareddrive` as an alias, since a
//     Shared Drive is the same storage with a different ownership model and the name/path rules match
//
// What differs is resolved at run time, not here: the validator derives its combination key from
// destinationProvider (so this pair is measured against utils/contentTolerance/
// dropboxToGoogleshareddrive.js and reported under its own name), and the destination-side agent
// resolves the Shared Drive BY NAME, per unit, because a Shared Drive's id doubles as its root
// folder id and one run may land in several drives.
const { register } = require('../../agentRegistry');
const DropboxTestDataAgent = require('../../../agents/dropbox/DropboxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/dropboxToGoogledrive');

register('content', 'dropbox', 'googleshareddrive', {
  TestDataAgent: DropboxTestDataAgent,
  ValidationAgent,
});
