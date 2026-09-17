// content: Box → Google My Drive
//
// A NEW combination, separate from box→sharepoint and box→onedrive (boxToSharepoint.js /
// boxToOnedrive.js), per CONTRIBUTING's "one combination = its own files" rule — those two share
// BoxTestDataAgent, which this combination deliberately does NOT reuse: the permission model, the
// shared-link model and the 34-feature scope are all different from SharePoint/OneDrive's, so a
// dedicated BoxToGoogledriveTestDataAgent seeds and this file registers it.
//
// A TestDataAgent IS registered here, unlike box→sharepoint (which reads whatever the source account
// already has): this combination follows the same arrangement as dropboxToGoogledrive.js and
// googledriveToSharepoint.js, both of which seed their own source data.
//
// Sixteen of the 34 in-scope features are Box Notes, which cannot be authored with real content
// through the public Box API — see the module comment on BoxToGoogledriveTestDataAgent and
// backend/data/feature-scope/box-to-google-inscope.md / -outscope.md / -testdata.md.
const { register } = require('../../agentRegistry');
const BoxToGoogledriveTestDataAgent = require('../../../agents/box/BoxToGoogledriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/boxToGoogledrive');

register('content', 'box', 'googledrive', {
  TestDataAgent: BoxToGoogledriveTestDataAgent,
  ValidationAgent,
});
