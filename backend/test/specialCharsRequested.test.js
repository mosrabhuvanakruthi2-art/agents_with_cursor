/**
 * Feature 5.1 must judge against what the JOB REQUESTED, not against a constant.
 *
 * migrationClient sends `specialCharacter=${context.replaceSpecialChar || '-'}` on EVERY job, so a
 * run always tells CloudFuze which character to substitute. Run 30e0806d sent
 * `specialCharacter=_`, CloudFuze renamed
 *
 *     "MS-invalid colon : name.txt"  ->  "MS-invalid colon _ name.txt"
 *
 * and 5.1 failed it with "no replacement was expected" — failing the product for doing exactly what
 * the job asked. Same mistake 4.1 made by judging created dates a job never asked to preserve.
 *
 * A rename that is NOT the requested substitution must still fail, or the check means nothing.
 */
const assert = require('assert');
const Agent = require('../src/validation/combinations/content/dropboxToGoogledrive');

function check(sourceNames, destNames, replaceSpecialChar) {
  const rows = [];
  const push = (status, name, detail) => rows.push({ status, name, detail });
  const sourceTree = sourceNames.map((n, i) => ({
    name: n, path: `/07-Special-Characters/${n}`, type: 'file', mimeType: 'text/plain',
  }));
  const matched = new Map(sourceTree.map((s, i) => [s.path, {
    source: s, dest: { name: destNames[i], id: `d${i}` },
  }]));
  const agent = new Agent();
  const totals = agent._emptyTotals({});
  agent._checkSpecialCharacters(push, sourceTree, { matched }, {}, totals,
    { replaceSpecialChar });
  return rows.find((r) => r.name.startsWith('5.1'));
}

// ── The real case from run 30e0806d ──────────────────────────────────────────────────────
const asked = check(
  ['MS-invalid colon : name.txt'],
  ['MS-invalid colon _ name.txt'],
  '_'
);
assert.strictEqual(asked.status, 'PASS',
  'a substitution the job explicitly requested is not a defect');
assert.ok(/specialCharacter="_"/.test(asked.detail),
  `the detail names the requested character, got: ${asked.detail}`);
assert.ok(/avoidable|preserved verbatim/.test(asked.detail),
  'the owner is still told Google would accept the character unchanged');

// ── Unchanged names still pass, with the original wording ────────────────────────────────
const unchanged = check(
  ['Special ~!@#$%^&()_+[]{};,.= chars.txt'],
  ['Special ~!@#$%^&()_+[]{};,.= chars.txt'],
  '_'
);
assert.strictEqual(unchanged.status, 'PASS', 'names that arrive intact still pass');
assert.ok(/UNCHANGED/.test(unchanged.detail), 'and say so');

// ── A rename that is NOT the requested substitution is still a real defect ───────────────
const wrong = check(
  ['MS-invalid colon : name.txt'],
  ['completely different name.txt'],
  '_'
);
assert.strictEqual(wrong.status, 'FAIL',
  'an arbitrary rename is still a defect — the check must not become unfalsifiable');

// Replaced with the WRONG character: the job asked for "_", CloudFuze used "-".
const wrongChar = check(
  ['MS-invalid colon : name.txt'],
  ['MS-invalid colon - name.txt'],
  '_'
);
assert.strictEqual(wrongChar.status, 'FAIL',
  'substituting a different character than the job requested is a defect');

// A character that is NOT special being changed is a defect even if the target char matches.
const nonSpecial = check(
  ['MS-invalid colon : name.txt'],
  ['MS-invalid colon : nameatxt'.replace('a', '_')],
  '_'
);
assert.strictEqual(nonSpecial.status, 'FAIL',
  'replacing an ordinary character is not the requested substitution');

// ── Mixed: one requested substitution, one genuine defect → FAIL, and both are named ─────
const mixed = check(
  ['MS-invalid colon : name.txt', 'MS-invalid pipe | name.txt'],
  ['MS-invalid colon _ name.txt', 'totally-renamed.txt'],
  '_'
);
assert.strictEqual(mixed.status, 'FAIL', 'a genuine defect alongside a requested rename still fails');
assert.ok(/totally-renamed\.txt/.test(mixed.detail), 'the real defect is named');
assert.ok(/not counted as defects/.test(mixed.detail),
  'and the requested substitution is explicitly excused rather than silently dropped');

// ── The default is "-" when the run sets nothing, matching migrationClient ───────────────
const defaulted = check(
  ['MS-invalid colon : name.txt'],
  ['MS-invalid colon - name.txt'],
  undefined
);
assert.strictEqual(defaulted.status, 'PASS',
  'migrationClient defaults specialCharacter to "-", so that substitution is requested too');

console.log('specialCharsRequested: OK');
