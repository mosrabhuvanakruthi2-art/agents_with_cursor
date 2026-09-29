/**
 * sharing/add_file_member reports a refusal INSIDE a 200 response, per member.
 *
 * Returning that array unread made every refusal look like a success: the seeding log recorded
 * nothing, and validation then said "No grant to <address> was found on any source item" — so
 * feature 2.5 read as NOT EXERCISED when Dropbox had actually refused the grant.
 *
 * The real response, measured against the QA account:
 *
 *   HTTP 200
 *   [{ "invitation_signature": ["…"],
 *      "member": { ".tag": "email", "email": "srinidhperla2004@gmail.com" },
 *      "result": { ".tag": "member_error", "member_error": { ".tag": "no_permission" } } }]
 *
 * An internal grant on the same file in the same call succeeds, so the danger is not limited to
 * external addresses — any silently refused grant would leave a permission feature quietly
 * unexercised.
 */
const assert = require('assert');
const { memberActionRefusal } = require('../src/clients/dropboxClient');

assert.strictEqual(typeof memberActionRefusal, 'function',
  'memberActionRefusal must be exported so this bug stays covered');

// ── The measured refusal ────────────────────────────────────────────────────────────────
const REFUSED = [{
  invitation_signature: ['3fd912c910b9fdf784b808221a56c13d802d2ecf:cfc58111'],
  member: { '.tag': 'email', email: 'srinidhperla2004@gmail.com' },
  result: { '.tag': 'member_error', member_error: { '.tag': 'no_permission' } },
  sckey_sha1: '3fd912c910b9fdf784b808221a56c13d802d2ecf',
}];
const refusal = memberActionRefusal(REFUSED);
assert.ok(refusal, 'a member_error in a 200 response is a refusal, not a success');
assert.ok(/no_permission/.test(refusal), `the reason is named, got: ${refusal}`);
assert.ok(/srinidhperla2004@gmail\.com/.test(refusal),
  `the refused member is named, got: ${refusal}`);

// ── A genuine success must stay silent ──────────────────────────────────────────────────
const GRANTED = [{
  member: { '.tag': 'email', email: 'ben@filefuze.co' },
  result: { '.tag': 'success', success: { '.tag': 'viewer' } },
}];
assert.strictEqual(memberActionRefusal(GRANTED), null,
  'an added member must not be reported as refused — internal grants do succeed here');

// Mixed batch: the refusal wins, and it names the member that was refused rather than the one
// that worked.
const MIXED = [GRANTED[0], REFUSED[0]];
const mixed = memberActionRefusal(MIXED);
assert.ok(mixed && /srinidhperla2004@gmail\.com/.test(mixed),
  `a partial refusal is still a refusal, got: ${mixed}`);
assert.ok(!/ben@filefuze\.co/.test(mixed), 'the successful member is not blamed');

// ── Shapes that must not throw ──────────────────────────────────────────────────────────
for (const odd of [null, undefined, [], {}, 'nonsense', [{}], [{ result: {} }]]) {
  assert.doesNotThrow(() => memberActionRefusal(odd),
    `a malformed response must not crash seeding: ${JSON.stringify(odd)}`);
}
assert.strictEqual(memberActionRefusal([]), null, 'an empty response is not a refusal');

// access_error is the other tag Dropbox uses for the same class of problem.
const ACCESS_ERR = [{
  member: { '.tag': 'email', email: 'nobody@example.invalid' },
  result: { '.tag': 'access_error', access_error: { '.tag': 'invalid_file' } },
}];
assert.ok(/invalid_file/.test(memberActionRefusal(ACCESS_ERR) || ''),
  'access_error is surfaced too, not just member_error');

console.log('dropboxMemberActionResult: OK');
