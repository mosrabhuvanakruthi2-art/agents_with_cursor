/**
 * Run: npm test  (from backend/)
 *
 * "Migrate Box Notes As: Docx / G-Docs" (frontend/src/components/runwizard/steps.jsx) needs to reach
 * CloudFuze as the `boxNotetoDoc` job option on Box→Google jobs — confirmed live 2026-09-23 via two
 * network captures of CloudFuze's own Team Migration wizard:
 *
 *   - onlyBoxNotes=true (its own separate "Only Box Notes" checkbox) restricts the ENTIRE migration
 *     to Box Notes files only, even with a full-tree source selected (job 443/444: 2 items processed
 *     out of ~76). That is the regression an earlier attempt (execution cc3d8f1b) reproduced by
 *     sending onlyBoxNotes=true unconditionally.
 *   - onlyBoxNotes and the "Migrate Box Notes As" format are INDEPENDENT controls. With "Only Box
 *     Notes" unchecked and "G-Docs" selected, a real full-tree run processed all 76 items AND the
 *     migrated Box Note opened natively in the Google Docs editor — a real conversion.
 *
 * So this app must always send onlyBoxNotes=false for Box→Google (it never exposes a notes-only
 * mode) and drive boxNotetoDoc from the user's format choice. Every other combination must be
 * unaffected — this is a Box→Google-specific job option, not a global one.
 *
 * These are static source assertions (no network, no Box/Google account), matching the pattern in
 * dropboxCreatedDates.test.js's testJobRequestsCreatedTimeByOption.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MigrationContext = require('../src/models/MigrationContext');

function testMigrationContextDefaultsAndNormalizesFormat() {
  assert.strictEqual(new MigrationContext({}).boxNotesFormat, 'docx',
    'no option named: defaults to docx, CloudFuze\'s own default');
  assert.strictEqual(new MigrationContext({ boxNotesFormat: 'gdoc' }).boxNotesFormat, 'gdoc');
  assert.strictEqual(new MigrationContext({ boxNotesFormat: 'docx' }).boxNotesFormat, 'docx');
  // Anything unrecognized (garbage, a stray value from an old client) falls back to docx rather
  // than being passed through to migrationClient unexamined.
  assert.strictEqual(new MigrationContext({ boxNotesFormat: 'something-else' }).boxNotesFormat, 'docx');
  assert.strictEqual(new MigrationContext({ boxNotesFormat: undefined }).boxNotesFormat, 'docx');
  console.log('  MigrationContext.boxNotesFormat defaults to docx and only \'gdoc\' opts in: ok');
}

function testAgentControllerThreadsTheField() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'controllers', 'agentController.js'), 'utf8');
  assert.ok(/boxNotesFormat:\s*req\.body\.boxNotesFormat/.test(src),
    'the single-pair run route must read boxNotesFormat off the request body into the context — '
    + 'otherwise the frontend selector has nothing to reach');
  console.log('  agentController reads req.body.boxNotesFormat into the MigrationContext: ok');
}

function testMigrationClientSendsBoxNotetoDocOnlyForBoxToGoogle() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'clients', 'migrationClient.js'), 'utf8');

  assert.ok(!/'onlyBoxNotes=true'/.test(src),
    'onlyBoxNotes=true must never be sent unconditionally — that is the confirmed scope-restriction '
    + 'regression (execution cc3d8f1b, and CloudFuze\'s own wizard job 443/444)');

  const gate = /\.\.\.\(isBoxToGoogleDrive \? \[\s*'onlyBoxNotes=false',\s*`boxNotetoDoc=\$\{context\.boxNotesFormat === 'gdoc'\}`,\s*\] : \[\]\)/;
  assert.ok(gate.test(src),
    'onlyBoxNotes=false and boxNotetoDoc must both be gated behind isBoxToGoogleDrive, and '
    + 'boxNotetoDoc must be derived from context.boxNotesFormat, not hardcoded');
  console.log('  onlyBoxNotes=false + boxNotetoDoc=<format> are sent together, only for Box→Google: ok');
}

function run() {
  testMigrationContextDefaultsAndNormalizesFormat();
  testAgentControllerThreadsTheField();
  testMigrationClientSendsBoxNotetoDocOnlyForBoxToGoogle();
  console.log('Box Notes format (Docx/G-Docs) wiring: all assertions passed');
}

run();
