// content: Dropbox → SharePoint Online
//
// The run wizard already offers both sides (frontend/src/components/runwizard/domains.js lists
// `dropbox` and `sharepoint` in CONTENT_SERVICES, which backs both sourceProviders and
// destProviders) and sends them verbatim. Without this registration a run fails at agent resolution
// before any validation runs — which is exactly what it did before this file existed. No frontend
// change was needed to make this pair selectable; only this registration.
//
// Unlike dropboxToGoogleshareddrive.js, which reuses the My Drive validator, this pair gets its OWN
// validator. Both halves of the reasoning matter:
//
//   - The DESTINATION is different in kind. That validator extends GoogleDriveValidationAgent and
//     reads the destination with driveClient; SharePoint is path-addressed within a site and read
//     through SharePointValidationAgent. The two destination agents share method names but have
//     incompatible signatures, so re-parenting is not possible.
//   - The DOCUMENTS are different. dropbox-to-sharepoint-inscope.md and dropbox-to-google-inscope.md
//     are separate documents with different feature numbering (Google has no Folder Display;
//     Versions is §3 here and §9 there; Paper is §11 here and §10 there) and inverted destination
//     rules — Google replaces no characters and has no path limit, SharePoint does both. Sharing
//     verdict logic would let a scope change to one pair move the other pair's results.
//
// What is NOT duplicated: the Dropbox API reading itself lives in clients/dropboxClient.js, which is
// destination-agnostic and shared by design.
//
// Feature scope: backend/data/feature-scope/dropbox-to-sharepoint-inscope.md (36 features) and
// -outscope.md (1). The scope document covers OneDrive as well, so `dropbox → onedrive` is a later
// registration reusing this validator — deliberately not added now, because nothing would exercise
// it.
const { register } = require('../../agentRegistry');
const DropboxTestDataAgent = require('../../../agents/dropbox/DropboxTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/dropboxToSharepoint');

register('content', 'dropbox', 'sharepoint', {
  TestDataAgent: DropboxTestDataAgent,
  ValidationAgent,
});
