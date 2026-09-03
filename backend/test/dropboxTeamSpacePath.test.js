/**
 * Run: npm test  (from backend/)
 *
 * Two fixes for the Dropbox → Google combination, plus the guarantee that neither reaches any
 * other combination.
 *
 * 1. TEAM-SPACE PATH (migrationClient). Dropbox Business has two namespaces. Seeding uses
 *    `Dropbox-API-Select-User`, which is member-scoped, so it reports "/QA-Automation". CloudFuze
 *    scans the TEAM space, where each member home sits under its own folder —
 *    "/Erik E/QA-Automation". Nine jobs sent the member path with every form of fromRootId
 *    (prefixed "id:…", bare id, the path itself, absent) and every one returned
 *    totalFilesAndFolders=0 with CONFLICT / "Migration not Allowed for wrong CSV paths". Prefixing
 *    the member folder moved 67/67 items, twice — jobs 6a981342b17d0e315c80d447 and
 *    6a981849b17d0e315c80ea26.
 *
 * 2. GOOGLE-DESTINATION CLEANUP (CleanupAgent). `sharepoint` was the only destination branch, so a
 *    Google destination was never cleaned and every re-run migrated on top of the last — validation
 *    then blamed the migration for the leftovers.
 *
 * The blast-radius assertions matter more than the feature ones: migrationClient is imported by
 * every content combination, and CleanupAgent DELETES.
 *
 * These assertions read the RAW source and match code-shaped patterns (`member.displayName`,
 * `u.fromRootId = teamPath`) rather than bare words. An earlier draft stripped comments first with
 * `/\/*[\s\S]*?\*\/|\/\/.*$/gm` — on migrationClient that removed 52% of the file INCLUDING live
 * code (`workspacePairs` disappeared), so the checks were evaluating shifted, truncated text and
 * passing for the wrong reason. Do not reintroduce that.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const migrationSrc = fs.readFileSync(path.join(SRC, 'clients', 'migrationClient.js'), 'utf8');
const cleanupSrc = fs.readFileSync(path.join(SRC, 'agents', 'cleanup', 'CleanupAgent.js'), 'utf8');

/** The helper body, sliced from the raw source. */
function helperBody() {
  const start = migrationSrc.indexOf('async function applyDropboxTeamSpacePaths');
  assert.ok(start > -1, 'the prefix helper exists');
  const end = migrationSrc.indexOf('\n}', start);
  assert.ok(end > start, 'the helper body is delimited');
  return migrationSrc.slice(start, end);
}

/**
 * The prefix step must be unreachable unless the SOURCE CLOUD is Dropbox.
 *
 * Gating on the registered cloud name rather than a path or provider string is copied from the
 * existing `isSharedDrive` gate: an earlier version of that keyed off where the bytes sat instead
 * of the cloud type, and a My Drive run started sending "/QA_Team1" as its source path.
 *
 * Asserted as one exact block, so a guard that gets loosened or removed fails here rather than
 * being matched by a nearby comment that happens to mention DROPBOX.
 */
function testGatedOnDropboxSourceOnly() {
  const guard = "if (/DROPBOX/i.test(String(context.sourceCloudName || ''))) {\n"
    + '      await applyDropboxTeamSpacePaths(units, logger);\n'
    + '    }';
  assert.ok(migrationSrc.includes(guard),
    'the call sits inside an exact DROPBOX test on context.sourceCloudName');

  // `await` included on purpose: without it this also counts the function declaration.
  const calls = (migrationSrc.match(/await applyDropboxTeamSpacePaths\(/g) || []).length;
  assert.strictEqual(calls, 1, 'exactly one call site, so there is one thing to audit');
  console.log('  prefix step reachable only for a DROPBOX source cloud: ok');
}

/**
 * The path must be built from Dropbox's own display casing, not lower-cased.
 *
 * DropboxTestDataAgent records a measurement reading the failure as a CASE problem
 * ("/QA-Automation" rejected, "/qa-automation" accepted). Those jobs all lacked the prefix, and
 * both jobs that ever succeeded used mixed case. Lower-casing here would produce
 * "/Erik E/qa-automation" — a string nothing has ever validated.
 */
function testUsesDisplayCasing() {
  const body = helperBody();

  assert.ok(body.includes('member.displayName'),
    'the member folder comes from the team member displayName');
  assert.ok(body.includes('dropboxClient.getMetadata('),
    'the path is re-resolved through Dropbox so it carries display casing');

  // Only the e-mail may be lower-cased (for member lookup); the path may not.
  const pathLines = body.split('\n').filter((l) => /teamPath|memberPath|u\.sourcePath\s*=/.test(l));
  assert.ok(pathLines.length >= 3, 'the path-building lines were found');
  for (const line of pathLines) {
    assert.ok(!/toLowerCase/.test(line) || /startsWith/.test(line),
      `path must keep display casing — lower-cased in: ${line.trim()}`);
  }

  // The id and the path have to describe the same object: a Dropbox "id:…" root was one of the
  // nine forms that scanned nothing.
  assert.ok(/u\.fromRootId\s*=\s*teamPath/.test(body), 'fromRootId mirrors the team-space path');
  console.log('  team path built from display casing, fromRootId mirrors it: ok');
}

/** Re-running must not double-prefix, or the path becomes /Erik E/Erik E/QA-Automation. */
function testIdempotent() {
  const body = helperBody();
  assert.ok(/startsWith\(`\$\{prefix\.toLowerCase\(\)\}\/`\)/.test(body),
    'an already-prefixed path is detected case-insensitively');
  const idx = body.indexOf('startsWith(`${prefix.toLowerCase()}/`)');
  assert.ok(body.slice(idx, idx + 120).includes('continue'),
    'and is skipped rather than prefixed twice');
  console.log('  already-prefixed path left untouched: ok');
}

/** A source whose member folder cannot be resolved must not silently migrate the wrong tree. */
function testFailsLoudNotSilent() {
  const body = helperBody();
  const warns = (body.match(/log\.warn\(/g) || []).length;
  assert.ok(warns >= 2,
    `an unresolvable member or path warns rather than passing silently (found ${warns})`);
  assert.ok(/continue;/.test(body),
    'and that unit keeps its original path instead of getting a guessed one');
  console.log('  unresolved member folder warns instead of migrating the wrong tree: ok');
}

// ── CleanupAgent ──────────────────────────────────────────────────────────────

/**
 * Every top-level name DropboxTestDataAgent can create must be on the cleanup allowlist.
 *
 * Derived from the agent itself rather than from a live tree: "12-Delta" is seeded only on a delta
 * run, so a snapshot of one run's source would have missed it — and this cross-check is what caught
 * it missing from the allowlist.
 */
function testDropboxNamesAllowlisted() {
  const agentSrc = fs.readFileSync(
    path.join(SRC, 'agents', 'dropbox', 'DropboxTestDataAgent.js'), 'utf8');

  const created = new Set();
  const re = /\$\{root\}\/(\d\d-[A-Za-z0-9_.-]+)/g;
  let m;
  while ((m = re.exec(agentSrc))) created.add(m[1]);
  assert.ok(created.size >= 12, `found ${created.size} seeded top-level names in the agent`);

  for (const name of created) {
    assert.ok(cleanupSrc.includes(`'${name}'`),
      `DropboxTestDataAgent creates "${name}" but cleanup would not delete it`);
  }
  console.log(`  all ${created.size} Dropbox seeded names allowlisted: ok`);
}

/**
 * The Google branch must exist, be allowlist-only, and never scan a bare drive root.
 *
 * The destination Shared Drive can be one the wider team uses: the account in play sees 1,000+
 * drives with 40 duplicate names, and resolveSharedDriveByName takes the FIRST match. A cleanup
 * that scanned a drive root would put other teams' data inside the blast radius.
 */
function testGoogleDestinationBranch() {
  assert.ok(cleanupSrc.includes("['googledrive', 'googleshareddrive'].includes(dstProvider)"),
    'a Google destination branch exists');
  assert.ok(cleanupSrc.includes("if (dstProvider === 'sharepoint' && context.destinationEmail) {"),
    'and the SharePoint branch is still there, unchanged');

  const start = cleanupSrc.indexOf("['googledrive', 'googleshareddrive'].includes(dstProvider)");
  const end = cleanupSrc.indexOf("if (dstProvider === 'sharepoint'", start);
  assert.ok(end > start, 'the Google branch sits before the SharePoint branch');
  const branch = cleanupSrc.slice(start, end);

  assert.ok(branch.includes('isSeededContentName('),
    'deletion is filtered through the seeded allowlist, never a blanket delete');
  assert.ok(/segments\.length === 0/.test(branch) && /refusing to/.test(branch),
    'a destination naming no folder is refused rather than scanned as a drive root');
  assert.ok(branch.includes('resolveSharedDriveByName'),
    'a Shared Drive destination is resolved by name from the first path segment');

  // The wrapper folder itself must survive: it may have pre-dated this run.
  assert.ok(!/deleteFile\(parentId/.test(branch),
    'the destination folder itself is never deleted, only allowlisted children');

  // Deletion must be scoped to a resolved folder id, not a name glob.
  assert.ok(/deleteFile\(t\.id/.test(branch), 'children are deleted by resolved id');
  console.log('  Google destination cleanup is allowlist-only and refuses drive roots: ok');
}

/** Nothing about the pre-existing SharePoint / Drive paths may have moved. */
function testOtherCombinationsUntouched() {
  for (const marker of [
    "if (dstProvider === 'sharepoint' && context.destinationEmail) {",
    "if (['googledrive', 'googleshareddrive'].includes(srcProvider) && context.sourceEmail) {",
  ]) {
    assert.ok(cleanupSrc.includes(marker), `pre-existing branch still present: ${marker}`);
  }

  // The create/job pair builder must not have gained the prefix logic inline — the prefix is
  // applied upstream, to `units`, and only for a Dropbox source.
  const pairStart = migrationSrc.indexOf('const workspacePairs = passedUnits.map(');
  assert.ok(pairStart > -1, 'the create/job pair builder is still there');
  const pairBody = migrationSrc.slice(pairStart, pairStart + 1200);
  assert.ok(!/displayName|applyDropboxTeamSpacePaths/.test(pairBody),
    'the pair builder is untouched');

  // Box→SharePoint and Drive→SharePoint reach triggerMigration through the same units array, so the
  // helper must not mutate a unit unless its member folder resolved.
  const body = helperBody();
  const assignIdx = body.indexOf('u.sourcePath = teamPath');
  assert.ok(assignIdx > -1, 'the mutation site exists');
  assert.ok(body.slice(0, assignIdx).includes('if (!member || !member.displayName)'),
    'no unit is mutated before the member folder has been resolved');
  console.log('  SharePoint + Drive branches and the pair builder untouched: ok');
}

testGatedOnDropboxSourceOnly();
testUsesDisplayCasing();
testIdempotent();
testFailsLoudNotSilent();
testDropboxNamesAllowlisted();
testGoogleDestinationBranch();
testOtherCombinationsUntouched();
console.log('dropboxTeamSpacePath.test.js: ok');
