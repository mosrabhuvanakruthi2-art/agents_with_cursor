'use strict';

/**
 * contentMappingVerdict — the pass/fail rule for one CloudFuze path-CSV mapping row.
 *
 * Why this file exists: for every content run in this project's history the verdict was "PASS"
 * because a mapping row came back at all, so a pair CloudFuze had already rejected was submitted
 * anyway and the job ran to PROCESSED having moved nothing. The rule below is what stops that, so it
 * is pinned here.
 *
 * Rows are trimmed copies of real cache/list responses from qarelease.cloudfuze.com.
 */

const assert = require('assert');
const { contentMappingVerdict } = require('../src/clients/migrationClient');

const unit = {
  sourceEmail: 'warner@snapbot.io',
  destinationEmail: 'warner@gajha.com',
  sourcePath: '/Agent Shared Drive',
  destinationPath: 'QA/Documents',
};

function row(overrides = {}) {
  const { src = {}, dst = {}, ...rest } = overrides;
  return {
    mapped: false,
    teamFolder: false,
    migrateFolderName: null,
    failMapping: false,
    pathException: false,
    sourceCloudDetails: {
      id: '6a7cb05add48f370c24ed2a5',
      emailId: 'warner@snapbot.io',
      folderPath: '/Agent Shared Drive',
      provisionedUser: true,
      userErrorDescription: null,
      sourcePathReview: null,
      ...src,
    },
    destCloudDetails: {
      id: '6a7c3b2791272c41fc9d7c2a',
      emailId: 'warner@gajha.com',
      folderPath: '/QA/Documents',
      provisionedUser: true,
      userErrorDescription: null,
      destPathReview: null,
      ...dst,
    },
    ...rest,
  };
}

// ── The real failure this fix exists for ────────────────────────────────────────
// Observed verbatim on qarelease: an unlicensed destination user. Before this rule the pair was
// reported PASS and submitted; the job then reported PROCESSED with zero files.
{
  const v = contentMappingVerdict(row({
    dst: { provisionedUser: false, userErrorDescription: 'Please Make this  as Licensed user' },
  }), unit);
  assert.strictEqual(v.validated, false, 'unlicensed destination user must not validate');
  assert.ok(/not provisioned/.test(v.blockReason), `blockReason should name provisioning: ${v.blockReason}`);
  assert.ok(/Licensed user/.test(v.blockReason), `blockReason must carry CloudFuze's own text: ${v.blockReason}`);
  assert.ok(/warner@gajha\.com/.test(v.blockReason), 'blockReason should name the failing user');
}

// ── A row with no blockers passes, but is NOT claimed to be reviewed ───────────
{
  const v = contentMappingVerdict(row(), unit);
  assert.strictEqual(v.validated, true, 'a row with no blockers validates');
  assert.strictEqual(v.srcReview, 'UNVALIDATED', 'null sourcePathReview is UNVALIDATED, never PASS');
  assert.strictEqual(v.dstReview, 'UNVALIDATED', 'null destPathReview is UNVALIDATED, never PASS');
  assert.strictEqual(v.mapped, false);
}

// ── CloudFuze's own review columns are used when present ──────────────────────
{
  const v = contentMappingVerdict(row({
    mapped: true,
    src: { sourcePathReview: 'PASS' },
    dst: { destPathReview: 'CREATED-PASS' },
  }), unit);
  assert.strictEqual(v.validated, true);
  assert.strictEqual(v.srcReview, 'PASS');
  assert.strictEqual(v.dstReview, 'CREATED-PASS');
  assert.strictEqual(v.mapped, true);
}

// ── An unprovisioned SOURCE blocks too ────────────────────────────────────────
{
  const v = contentMappingVerdict(row({ src: { provisionedUser: false } }), unit);
  assert.strictEqual(v.validated, false);
  assert.ok(/source user warner@snapbot\.io is not provisioned/.test(v.blockReason), v.blockReason);
}

// ── failMapping / pathException flags block ───────────────────────────────────
{
  const v = contentMappingVerdict(row({ failMapping: true }), unit);
  assert.strictEqual(v.validated, false);
  assert.ok(/failMapping/.test(v.blockReason), v.blockReason);
}
{
  const v = contentMappingVerdict(row({ pathException: true }), unit);
  assert.strictEqual(v.validated, false);
  assert.ok(/pathException/.test(v.blockReason), v.blockReason);
}

// ── Every blocker is reported, not just the first ──────────────────────────────
{
  const v = contentMappingVerdict(row({
    src: { provisionedUser: false },
    dst: { provisionedUser: false, userErrorDescription: 'Please Make this  as Licensed user' },
    failMapping: true,
  }), unit);
  assert.strictEqual(v.validated, false);
  assert.strictEqual(v.blockReason.split('; ').length, 4, `expected 4 blockers, got: ${v.blockReason}`);
}

// ── teamFolder comes off the mapping row, as a string, defaulting to "false" ──
// It was previously read off unmapped/list, where a Shared Drive always came back false.
{
  assert.strictEqual(contentMappingVerdict(row({ teamFolder: true }), unit).teamFolder, 'true');
  assert.strictEqual(contentMappingVerdict(row({ teamFolder: false }), unit).teamFolder, 'false');
  assert.strictEqual(contentMappingVerdict(row({ teamFolder: null }), unit).teamFolder, 'false');
}

// ── Per-user SUB-cloud ids are surfaced, so a named CSV user is not migrated as the admin ──
{
  const v = contentMappingVerdict(row(), unit);
  assert.strictEqual(v.srcCloudId, '6a7cb05add48f370c24ed2a5');
  assert.strictEqual(v.dstCloudId, '6a7c3b2791272c41fc9d7c2a');
}

// ── migrateFolderName passes through as a real null, never the string "null" ──
{
  assert.strictEqual(contentMappingVerdict(row(), unit).migrateFolderName, null);
  assert.strictEqual(contentMappingVerdict(row({ migrateFolderName: 'FromCloudFuze' }), unit).migrateFolderName, 'FromCloudFuze');
}

// ── A missing/empty row must not throw and must not validate silently ─────────
{
  const v = contentMappingVerdict({}, unit);
  assert.strictEqual(v.validated, true, 'an empty row has no blockers…');
  assert.strictEqual(v.srcReview, 'UNVALIDATED', '…but is reported UNVALIDATED, so it is never a claimed pass');
  assert.strictEqual(v.srcCloudId, null);
}

console.log('contentMappingVerdict.test.js: ok');
