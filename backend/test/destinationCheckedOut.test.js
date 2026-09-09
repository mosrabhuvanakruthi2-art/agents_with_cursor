'use strict';

/**
 * Destination files that are checked out are invisible to the destination user.
 *
 * SharePoint hides a file that is checked out by someone else and has never been checked in. Our
 * reads use an app-only Graph token, which sees such files regardless. On 2026-08-25 that gap let a
 * run look healthy while the destination user saw nothing: 41 files were delivered, every one of them
 * checked out to "SharePoint App", and the user's folder view was empty. Presence and availability are
 * different questions and the validator has to ask both.
 *
 * Two things have to hold for that check to work, and both are easy to break silently:
 *
 *   1. Graph does NOT return the `publication` facet unless it is named in $select — and naming any
 *      field drops every default field not named. So buildFolderTree must request the full list.
 *   2. buildFolderTree must map publication.level === 'checkout' onto a flag the validator reads.
 *
 * These are static checks over the client source: no credentials, so they run in the normal chain.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'clients', 'sharepointClient.js'), 'utf8'
);
const VAL_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'validation', 'combinations', 'content', 'googledriveToSharepoint.js'),
  'utf8'
);

// ── 1. The tree request must ask for publication ──────────────────────────────
{
  const decl = /const TREE_FIELDS = \[([\s\S]*?)\]\.join/.exec(SP_SRC);
  assert.ok(decl, 'TREE_FIELDS should exist in sharepointClient.js');
  const fields = decl[1];
  assert.ok(/'publication'/.test(fields),
    'TREE_FIELDS must include publication — without it Graph omits check-out state entirely');

  // Naming any field suppresses the defaults, so everything buildFolderTree reads must be listed.
  for (const required of ['id', 'name', 'size', 'folder', 'file', 'createdBy', 'lastModifiedBy',
    'createdDateTime', 'lastModifiedDateTime', 'fileSystemInfo']) {
    assert.ok(new RegExp(`'${required}'`).test(fields),
      `TREE_FIELDS must include ${required} — $select drops every field it does not name`);
  }

  assert.ok(/listFolderChildren\(siteId, rootPath, email, \{ select: TREE_FIELDS \}\)/.test(SP_SRC),
    'buildFolderTree must pass TREE_FIELDS, otherwise publication is never requested');
}

// ── 2. checkout state must be mapped onto the item ───────────────────────────
{
  assert.ok(/checkedOut:\s*item\.publication\s*\?\s*item\.publication\.level === 'checkout'/.test(SP_SRC),
    'buildFolderTree must map publication.level === "checkout" to a checkedOut flag');
  assert.ok(/checkedOutBy:/.test(SP_SRC),
    'and record who holds the check-out, so the report can name them');
}

// ── 3. The validator must actually fail on it ────────────────────────────────
{
  assert.ok(/Destination files available to the user/.test(VAL_SRC),
    'the combination validator should carry a destination-availability check');
  const block = VAL_SRC.slice(VAL_SRC.indexOf('Destination files still checked out'));
  assert.ok(/\.filter\(\(d\) => d\.checkedOut\)/.test(block),
    'the check must select items by the checkedOut flag');
  assert.ok(/push\('FAIL'/.test(block.slice(0, 1600)),
    'and must emit FAIL — reporting invisible files as a pass is the bug this guards');
  assert.ok(/Require documents to be checked out/.test(block.slice(0, 2200)),
    'the failure text should name the destination setting that causes it, so it is actionable');
}

// ── 4. Verdict logic, exercised directly ─────────────────────────────────────
{
  // Mirrors the branch in the validator: PASS only when nothing is checked out.
  const verdict = (files) => {
    if (files.length === 0) return 'INFO';
    return files.some((f) => f.checkedOut) ? 'FAIL' : 'PASS';
  };
  const file = (checkedOut) => ({ type: 'file', checkedOut });

  assert.strictEqual(verdict([]), 'INFO', 'no files to assess');
  assert.strictEqual(verdict([file(false), file(false)]), 'PASS', 'all checked in');
  assert.strictEqual(verdict([file(true), file(true)]), 'FAIL', 'all invisible — the 2026-08-25 case');
  assert.strictEqual(verdict([file(false), file(true)]), 'FAIL',
    'even one invisible file means the destination is not fully usable');
}

console.log('destinationCheckedOut.test.js: ok');
