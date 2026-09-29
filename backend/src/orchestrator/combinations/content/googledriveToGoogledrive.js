// content: Google My Drive → Google My Drive
//
// The run wizard already offers googledrive as both a source and a destination content provider
// (frontend/src/components/runwizard/domains.js lists it in CONTENT_SERVICES), so a user can select
// this pair today. Without this registration the run fails at agent resolution before any validation
// runs — the same gap the Dropbox → Google combination had.
//
// DriveTestDataAgent seeds the source, exactly as googledrive → sharepoint already does — same
// source provider, same seeder.
//
// It was deliberately left unregistered at first, on the grounds that
// backend/data/feature-scope/my-drive-to-my-drive-testdata.md calls for six Google NATIVE types
// documented to conflict (Vids, Forms, My Maps, Apps Script, Sites) plus a Drawing, a file with
// more than five PINNED versions, and a cross-tenant user-mapping CSV — none of which this agent
// creates — and that registering it would let a run report "pass" on features it never touched.
//
// That risk turned out to be already covered: the feature checklist reports an unexercised feature
// as NOT ASSESSED, never as pass. Run 0700d557 seeded with this very agent and came back
// "Features: 3 pass, 1 fail, 20 not assessed (of 24)" — the twenty it cannot seed are visibly
// absent from the pass column, which is the outcome the scope document asks for.
//
// What leaving it unregistered cost was concrete: with no seeder and "Use existing source folder"
// unticked there is no source folder at all, so the run is refused (AgentOrchestrator's fail-fast
// guard) — and before that guard existed it silently migrated the drive ROOT instead (e215d157).
// The seven features this agent does cover are worth exercising by default; the rest stay honest
// as "not assessed" until a Drive-to-Drive seeder can create them.
//
// Scope: my-drive-to-my-drive-inscope.md (17 features), -outscope.md (7 limitations), -testdata.md.
const { register } = require('../../agentRegistry');
const DriveTestDataAgent = require('../../../agents/drive/DriveTestDataAgent');
const ValidationAgent = require('../../../validation/combinations/content/googledriveToGoogledrive');

register('content', 'googledrive', 'googledrive', {
  TestDataAgent: DriveTestDataAgent,
  ValidationAgent,
});
