/**
 * Re-run VALIDATION ONLY against an execution that already migrated.
 *
 *   node scripts/revalidate-execution.js <executionId>
 *
 * Why this exists: a full content run is cleanup + seeding + CloudFuze migration + validation, and
 * the first three take over half an hour. Almost every validator change needs none of them — the
 * source and destination are already sitting there from the last run. This replays just the
 * validation agent against the stored context, so a validator fix can be checked in a few minutes
 * instead of re-seeding two Shared Drives to look at the same data again.
 *
 * Read-only with respect to both clouds: the validation agents only read. Nothing is seeded,
 * migrated, deleted, or written to the execution record — the result is printed, not saved, so a
 * re-validation never overwrites the real run's report.
 *
 * The orchestrator's own skipTestData / skipMigration flags are not usable here: they read the
 * previous migrationResult off the SAME execution id, so they serve resumeFlow() on an INTERRUPTED
 * run rather than an ad-hoc replay of a COMPLETED one.
 */
const { connectMongo, getDb } = require('../src/db/mongo');
const logger = require('../src/utils/logger');
const MigrationContext = require('../src/models/MigrationContext');
const ValidationResult = require('../src/models/ValidationResult');
const { resolve: resolveAgents } = require('../src/orchestrator/agentRegistry');

const ID = process.argv[2];

function loadFromFileStore(id) {
  const fs = require('fs');
  const path = require('path');
  const p = path.resolve(__dirname, '../data/executions.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  return list.find((e) => (e.executionId || e._id) === id) || null;
}

(async () => {
  if (!ID) {
    console.error('usage: node scripts/revalidate-execution.js <executionId>');
    process.exit(1);
  }

  let doc = null;
  try {
    await connectMongo(logger);
    doc = await getDb().collection('executions').findOne({ _id: ID });
  } catch (e) {
    console.log('mongo unavailable (' + String(e.message).slice(0, 60) + ') — trying the file store');
  }
  if (!doc) doc = loadFromFileStore(ID);
  if (!doc) {
    console.error('execution ' + ID + ' not found in mongo or the file store');
    process.exit(1);
  }

  // Rebuild the context the run used, then graft on what the migration discovered — the per-unit
  // drives and destinations. Without migratedUsers/userFolderMappings the validator has no units and
  // silently validates nothing, which would look like a pass.
  const stored = doc.context || {};
  const mr = (doc.result || {}).migrationResult || {};
  const context = new MigrationContext(stored);
  Object.assign(context, stored, {
    migratedUsers: stored.migratedUsers || mr.migratedUsers || [],
    userFolderMappings: stored.userFolderMappings || [],
    // permissionMapping lives on the MIGRATION RESULT, not the context, and buildEmailMap reads it
    // as a third source alongside userEmailMappings and migratedUsers. Omitting it made a replay
    // disagree with the run it was replaying: the run mapped 30 user pairs through CloudFuze's
    // email match, while the replay saw only the one explicit Map Users pair and reported every
    // other principal — mia, alex, warner — as "not migratable / unmapped".
    permissionMapping: stored.permissionMapping || mr.permissionMapping || null,
    // Same reason: the validator reads the CloudFuze job status off the context.
    contentMigrationReport: stored.contentMigrationReport || (doc.result || {}).contentMigrationReport || null,
  });

  const mapCount = Object.keys(require('../src/validation/shared/deepContentCore').buildEmailMap(context)).length;
  if (mapCount === 0) {
    console.error('WARNING: no email mappings restored — every principal would be reported unmapped, '
      + 'so the replay would not resemble the run. Check that this execution stored its permissionMapping.');
  }

  const units = (context.migratedUsers || []).length || (context.userFolderMappings || []).length;
  console.log('execution   : ' + ID);
  console.log('combination : ' + context.sourceProvider + ' -> ' + context.destinationProvider);
  console.log('units       : ' + units);
  console.log('email map   : ' + mapCount + ' principal(s)');
  if (units === 0) {
    console.error('\nNo transfer units on this execution — nothing to validate. A run that never '
      + 'reached the migration step cannot be re-validated.');
    process.exit(1);
  }
  for (const u of (context.migratedUsers || [])) {
    console.log('   ' + (u.sourceDriveName || '(no drive)') + '  ' + u.sourcePath + '  ->  ' + u.destinationPath);
  }

  // Requiring agentRegistry auto-loads every combinations/<domain>/<combo>.js, so the registration
  // for this pair is already in place.
  const agents = resolveAgents('content', context.sourceProvider, context.destinationProvider);
  const ValidationAgent = agents && agents.ValidationAgent;
  if (!ValidationAgent) {
    console.error('no validation agent registered for content '
      + context.sourceProvider + ' -> ' + context.destinationProvider);
    process.exit(1);
  }

  console.log('\nrunning ' + ValidationAgent.name + ' (validation only)...\n');
  const started = Date.now();
  const agent = new ValidationAgent();
  const result = await agent.run(context, new ValidationResult({ executionId: ID }));
  const secs = Math.round((Date.now() - started) / 1000);

  const vr = result || {};
  const checks = vr.checks || [];
  const fc = (vr.featureChecklist || []);
  const tally = fc.reduce((a, f) => { a[f.status] = (a[f.status] || 0) + 1; return a; }, {});
  console.log('\n──────── result (' + secs + 's) ────────');
  console.log('checklist: ' + JSON.stringify(tally) + ' of ' + fc.length);
  console.log('\nFAIL features:');
  for (const f of fc.filter((x) => x.status === 'fail')) {
    console.log('  ' + f.id + ' ' + f.feature + ' :: ' + String(f.detail).slice(0, 140));
  }
  console.log('\nglobal checks that are not PASS:');
  for (const c of checks.filter((x) => !/PASS/i.test(x.status))) {
    console.log('  [' + c.status + '] ' + c.name + ' :: ' + String(c.detail).slice(0, 140));
  }
  for (const u of vr.perUser || []) {
    console.log('\n== ' + u.destinationPath + ' [' + u.status + '] ==');
    for (const c of (u.checks || []).filter((x) => /FAIL|WARN/i.test(x.status))) {
      console.log('  [' + c.status + '] ' + String(c.name).slice(0, 48) + ' :: ' + String(c.detail).slice(0, 150));
    }
  }
  console.log('\nNOT saved to the execution record — this was a replay.');
  process.exit(0);
})().catch((e) => {
  console.error('ERR ' + e.message);
  process.exit(1);
});
