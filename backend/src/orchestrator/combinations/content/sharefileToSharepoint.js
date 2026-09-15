// content: Citrix ShareFile → SharePoint Online
//
// Registers both agents, the same shape as dropboxToSharepoint.js. The MigrationAgent is NOT
// registered here and must not be — AgentOrchestrator instantiates the shared one itself
// (`new MigrationAgent()`), so no combination owns it.
//
// ShareFileTestDataAgent seeds into SHAREFILE_TEST_ROOT. It is idempotent (an existing folder
// answers HTTP 409 and is reused), so re-running after a correction updates the tree rather than
// silently doing nothing. The validator independently checks that the folder exists and is
// non-empty before comparing, and fails with that reason rather than reporting an empty source as a
// migration defect.
//
// ── Status (2026-09-09) ────────────────────────────────────────────────────────
// The ShareFile client is written but UNVERIFIED — no ShareFile credentials existed when it was
// written, so not one call has been executed against a live tenant. Run
// `sharefileClient.verifyConnection()` first once credentials are configured; it exercises auth, the
// API host handshake, root resolution and a child listing in one call.
//
// Permissions (features 2.1–2.4) are reported as NOT ASSESSED on this combination — the feature
// document publishes no ShareFile-role → SharePoint-role mapping. See
// validation/roleMaps/sharefile_to_sharepoint.js and
// data/feature-scope/sharefile-to-sharepoint-outscope.md.
//
// Nothing on this combination may be classified as a known limitation: no out-of-scope document
// exists for it, so there is nothing to classify against.
//
// Feature scope: backend/data/feature-scope/sharefile-to-sharepoint-{inscope,outscope}.md (11 features)
// Destination behaviour is inherited from agents/sharepoint/SharePointValidationAgent.js, shared with
// box→sharepoint and googledrive→sharepoint — not copied here.
const { register } = require('../../agentRegistry');
const ShareFileTestDataAgent = require('../../../agents/sharefile/ShareFileTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/sharefileToSharepoint');

register('content', 'sharefile', 'sharepoint', {
  TestDataAgent: ShareFileTestDataAgent,
  ValidationAgent,
  /**
   * Job options this pair needs, which the run wizard has no field for.
   *
   * `createGroups` — in-scope feature 2.3 is Group Permissions, and CloudFuze carries a grant made
   * to a GROUP only if it also creates that group at the destination. Without it there is no
   * principal to grant to, so the grant is dropped while user grants on the same folder arrive
   * normally — exactly the asymmetry this combination kept reporting.
   *
   * The flag was never sent by anything, so every run used CloudFuze's default `false` (visible as
   * `"createGroups":false` in the job response), and the validator reported ten dropped group
   * grants as a product defect. It may still be one. But it cannot be called one until the job has
   * actually asked, and until this line existed it never had.
   */
  contentOptionDefaults: { createGroups: true },
});
