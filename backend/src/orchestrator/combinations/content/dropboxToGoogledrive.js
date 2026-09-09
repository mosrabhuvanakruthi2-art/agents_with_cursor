// content: Dropbox → Google My Drive
//
// The run wizard already offers Dropbox as a content provider (frontend/src/components/runwizard/
// domains.js lists it in CONTENT_SERVICES) and sends `dropbox` verbatim as sourceProvider. Without
// this registration a run fails at agent resolution before any validation runs.
//
// A TestDataAgent IS registered here, unlike the Box→SharePoint content combinations: the Dropbox
// source is seeded by this repo (DropboxTestDataAgent), following the same arrangement as
// googledriveToSharepoint, which registers DriveTestDataAgent.
//
// Nineteen of the 36 in-scope features are Dropbox Paper, which cannot be seeded by API — Dropbox
// retired the Paper authoring endpoints. The seeding agent returns explicit manual steps for those
// instead of pretending to cover them. See backend/data/feature-scope/dropbox-to-google-inscope.md
// and -testdata.md.
const { register } = require('../../agentRegistry');
const DropboxTestDataAgent = require('../../../agents/dropbox/DropboxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/dropboxToGoogledrive');

register('content', 'dropbox', 'googledrive', {
  TestDataAgent: DropboxTestDataAgent,
  ValidationAgent,
});
