/**
 * Run: npm test  (from backend/)
 *
 * Group permissions and the anonymous-link exemption.
 *
 * All four bugs below were reported as migration defects on a run whose destination was actually
 * correct. Every one of them was ours:
 *
 *   1. Graph returns a GROUP grant as { group, siteUser }. sharepointClient tested `siteUser`
 *      first, so every migrated group was classified as a USER whose email was SharePoint's
 *      claims string (c:0t.c|tenant|<objectId>). Nothing can ever match that.
 *   2. comparePermissions then demanded a destination USER mapping for the group. Mapped to a
 *      person it failed against someone who was never meant to hold the grant; left unmapped it
 *      was excused as "not migratable" — while all four group grants had migrated correctly.
 *   3. compareSharedLinks decided the anonymous exemption by regex over a rendered message whose
 *      text carried the item's OTHER links, so an item holding both an anonymous and an
 *      organization link never matched the pattern and was reported as a defect.
 *   4. The feature checklist ignored that exemption entirely — one run showed 4 failing checks
 *      beside 16 failing features, 7 of them anonymous rows check 9b had already excused.
 *
 * The Graph shapes asserted here were captured live against trydemos.sharepoint.com/sites/QA on
 * 2026-08-26. They are not invented.
 */
const assert = require('assert');

const core = require('../src/validation/shared/deepContentCore');
const { computeContentFunctionalityChecklist } = require('../src/validation/shared/contentFunctionalityChecklist');

let failures = 0;
function check(name, fn) {
  try {
    fn();
  } catch (err) {
    failures++;
    console.error('  FAIL ' + name + '\n        ' + err.message);
  }
}

// ── 1. Graph principal classification ────────────────────────────────────────
// Mirrors the resolution order in sharepointClient.getItemPermissions. A group carries BOTH
// `group` and `siteUser`; only a person carries `user`. Group must therefore resolve FIRST.
function classify(granted) {
  const group = granted.group || granted.siteGroup || null;
  const user = group ? null : (granted.user || granted.siteUser || null);
  const principal = group || user;
  return {
    email: (principal && (principal.email || principal.loginName) || '').toLowerCase() || null,
    name: (principal && principal.displayName) || null,
    principalType: group ? 'group' : (user ? 'user' : 'unknown'),
  };
}

function testClassification() {
  // Captured verbatim: a migrated Google group arrives with NO email, only a display name.
  const migratedGroup = classify({
    group: { displayName: 'qa-group-view', id: 'b509cd29-5d34-4f3c-9f9c-036839910759' },
    siteUser: {
      displayName: 'qa-group-view',
      id: '76',
      loginName: 'c:0t.c|tenant|b509cd29-5d34-4f3c-9f9c-036839910759',
    },
  });
  check('a migrated group is classified as a group, not a user', function () {
    assert.strictEqual(migratedGroup.principalType, 'group');
  });
  check('a group with no email keeps its display name', function () {
    assert.strictEqual(migratedGroup.name, 'qa-group-view');
  });
  // The regression itself: a claims string must never become a principal identity.
  check('no principal is identified by a claims string', function () {
    assert.ok(
      !/^c:0[a-z]\./.test(migratedGroup.email || ''),
      'email leaked the claims string: ' + migratedGroup.email
    );
  });

  // An M365 group DOES carry an email — still a group.
  const modernGroup = classify({
    group: {
      displayName: 'Everyone at Exinent Members',
      email: 'EveryoneatExinent@gajha.com',
      id: '6f750f5f-8ec6-4957-862d-a9a6196f02ba',
    },
    siteUser: {
      displayName: 'Everyone at Exinent Members',
      email: 'EveryoneatExinent@gajha.com',
      id: '12',
      loginName: 'c:0o.c|federateddirectoryclaimprovider|6f750f5f',
    },
  });
  check('an M365 group that has an email is still a group', function () {
    assert.strictEqual(modernGroup.principalType, 'group');
  });

  // A real person.
  const person = classify({
    user: { displayName: 'alex', email: 'alex@gajha.com', id: 'd642aa17' },
    siteUser: {
      displayName: 'alex',
      email: 'alex@gajha.com',
      id: '58',
      loginName: 'i:0-hash-f|membership|alex@gajha.com',
    },
  });
  check('a person is still classified as a user', function () {
    assert.strictEqual(person.principalType, 'user');
  });
  check('a person keeps their real address', function () {
    assert.strictEqual(person.email, 'alex@gajha.com');
  });

  // A SharePoint built-in site group.
  const siteGroup = classify({
    siteGroup: { displayName: 'QA Members', id: '5', loginName: 'QA Members' },
  });
  check('a SharePoint site group is a group', function () {
    assert.strictEqual(siteGroup.principalType, 'group');
  });

  // A link permission grants to nobody.
  check('a link permission has no principal', function () {
    assert.strictEqual(classify({}).principalType, 'unknown');
  });
}

// ── 2. comparePermissions — groups match group-to-group ──────────────────────
function G(name, roles, email) {
  return { principalType: 'group', name: name, email: email || null, roles: roles };
}
function U(email, roles) {
  return { principalType: 'user', email: email, name: email, roles: roles };
}
// A mapEmail that maps nothing. A group must not need one.
function noMap(e, opts) {
  const lower = String(e).toLowerCase();
  return opts && opts.detail ? { email: lower, mapped: false } : lower;
}

function testGroupMatching() {
  // The four real folder grants. qa-group-view holds TWO different roles on two different
  // folders, so this proves the role travels with the item rather than the group merely existing.
  const cases = [
    ['folder_reader', 'qa-group-view@filefuze.co', 'reader', G('qa-group-view', ['read'])],
    ['folder_fileOrganizer', 'qa-group-view@filefuze.co', 'fileOrganizer', G('qa-group-view', ['write'])],
    ['folder_commenter', 'qa-group-edit@filefuze.co', 'commenter', G('qa-group-edit', ['read'])],
    ['folder_writer', 'qa-group-manage@filefuze.co', 'writer', G('qa-group-manage', ['write'])],
  ];
  cases.forEach(function (c) {
    const label = c[0];
    const res = core.comparePermissions([{ email: c[1], role: c[2], type: 'group' }], [c[3]], noMap);
    check(label + ': the group grant matches', function () {
      assert.strictEqual(res.mismatches.length, 0, 'mismatched: ' + JSON.stringify(res.mismatches));
      assert.strictEqual(res.matches.length, 1);
      assert.strictEqual(res.matches[0].principalType, 'group');
    });
    check(label + ': a group is never an unmapped principal', function () {
      assert.strictEqual(
        res.unmappedPrincipals.length, 0,
        'a group needs no Map Users entry — CloudFuze migrates it as a group'
      );
    });
  });

  // Local parts differ only by punctuation across the two tenants.
  const ex = core.comparePermissions(
    [{ email: 'everyone_at_exinent@filefuze.co', role: 'fileOrganizer', type: 'group' }],
    [G('Everyone at Exinent Members', ['write'], 'EveryoneatExinent@gajha.com')],
    noMap
  );
  check('punctuation differences do not break group matching', function () {
    assert.strictEqual(ex.mismatches.length, 0, JSON.stringify(ex.mismatches));
  });

  // NEGATIVE — the group is simply not at the destination.
  const gone = core.comparePermissions(
    [{ email: 'qa-group-view@filefuze.co', role: 'reader', type: 'group' }], [], noMap
  );
  check('NEGATIVE a group absent from the destination fails', function () {
    assert.strictEqual(gone.mismatches.length, 1);
    assert.strictEqual(
      gone.unmappedPrincipals.length, 0,
      'absent is a failure, not "not migratable"'
    );
  });

  // NEGATIVE — present, but under-granted.
  const weak = core.comparePermissions(
    [{ email: 'qa-group-manage@filefuze.co', role: 'writer', type: 'group' }],
    [G('qa-group-manage', ['read'])],
    noMap
  );
  check('NEGATIVE a group granted less access than the source fails', function () {
    assert.strictEqual(weak.mismatches.length, 1);
  });

  // NEGATIVE — a USER of the same name must not satisfy a group grant. Allowing it is what made
  // one group row unfalsifiable: the mapped person already held a direct grant on that folder.
  const impostor = core.comparePermissions(
    [{ email: 'qa-group-view@filefuze.co', role: 'reader', type: 'group' }],
    [U('qa-group-view@gajha.com', ['read'])],
    noMap
  );
  check('NEGATIVE a user cannot satisfy a group grant', function () {
    assert.strictEqual(
      impostor.mismatches.length, 1,
      'a same-named user is not the group — that check would be unfalsifiable'
    );
  });

  // A USER still requires a mapping: the group branch must not weaken user handling.
  const user = core.comparePermissions(
    [{ email: 'mia@filefuze.co', role: 'reader', type: 'user' }], [U('mia@gajha.com', ['read'])], noMap
  );
  check('a user with no mapping is still reported as unmapped', function () {
    assert.strictEqual(user.unmappedPrincipals.length, 1);
  });
}

// ── 3. compareSharedLinks — which anonymous losses are excusable ─────────────
function L(type, role) {
  return { type: type, role: role };
}
function D(scope, type) {
  return { scope: scope, type: type, roles: [type === 'edit' ? 'write' : 'read'] };
}

function testAnonymousExemption() {
  // The four rows that were wrongly failed: the source carries BOTH links and the destination
  // holds the organization one, so the anonymous loss is explained and excusable.
  const mixed = core.compareSharedLinks(
    [L('anyone', 'reader'), L('domain', 'reader')], [D('organization', 'view')]
  );
  check('an anonymous loss beside a matched organization link is excusable', function () {
    const anon = mixed.mismatches.filter(function (m) { return m.sourceType === 'anyone'; })[0];
    assert.ok(anon, 'the anonymous link should still be reported as a mismatch');
    assert.strictEqual(anon.anonymousExcusable, true);
    assert.ok(
      !mixed.mismatches.some(function (m) { return m.sourceType === 'domain'; }),
      'the organization link matched'
    );
  });

  // The destination holds nothing at all — consistent with the site refusing anonymous sharing.
  const bare = core.compareSharedLinks([L('anyone', 'reader')], []);
  check('an anonymous loss with no destination link at all is excusable', function () {
    assert.strictEqual(bare.mismatches[0].anonymousExcusable, true);
  });

  // NEGATIVE — a public link NARROWED to organization with no organization source link to
  // explain it. The destination demonstrably can hold a link; it holds a weaker one. Data loss.
  const narrowed = core.compareSharedLinks([L('anyone', 'reader')], [D('organization', 'view')]);
  check('NEGATIVE a public link narrowed to organization is NOT excusable', function () {
    assert.strictEqual(
      narrowed.mismatches[0].anonymousExcusable, false,
      'excusing this would hide real data loss'
    );
  });

  // The real defect shape: the organization EDIT link never arrived, while the anonymous loss
  // beside it is excused.
  const editLost = core.compareSharedLinks([L('anyone', 'reader'), L('domain', 'writer')], []);
  check('an organization edit link that never arrived is a real mismatch', function () {
    const dom = editLost.mismatches.filter(function (m) { return m.sourceType === 'domain'; })[0];
    assert.ok(dom, 'the organization edit link must be reported');
    assert.notStrictEqual(
      dom.anonymousExcusable, true,
      'an organization link is never anonymous-excusable'
    );
  });

  // An organization link downgraded from edit to view is still a failure.
  const domOnly = core.compareSharedLinks([L('domain', 'writer')], [D('organization', 'view')]);
  check('an organization link downgraded from edit to view still fails', function () {
    assert.strictEqual(domOnly.mismatches.length, 1);
    assert.notStrictEqual(domOnly.mismatches[0].anonymousExcusable, true);
  });
}

// ── 4. The feature checklist must agree with check 9b ───────────────────────
function obs(linkType, role, itemType, match) {
  return {
    linkType: linkType,
    role: role,
    itemType: itemType,
    match: match,
    path: '/x_' + linkType + '_' + role,
  };
}

function baseDcv(extra) {
  const base = {
    enabled: true,
    scannedSourceItems: 10,
    pairedCount: 10,
    missing: [],
    extra: [],
    misplaced: [],
    placeholderLinks: [],
    metadataChecked: true,
    linksChecked: true,
    permissionObservations: [],
    fileTypes: [],
    specialChars: { total: 0, arrived: 0 },
    linkObservations: [],
  };
  return Object.assign(base, extra);
}

function byId(rows) {
  const out = {};
  rows.forEach(function (r) { out[r.id] = r; });
  return out;
}

function testChecklistExemption() {
  const anonRows = [
    obs('anyone', 'reader', 'folder', false),
    obs('anyone', 'commenter', 'folder', false),
    obs('anyone', 'reader', 'file', false),
  ];

  const blocked = byId(computeContentFunctionalityChecklist(
    baseDcv({ linkObservations: anonRows, anonymousBlocked: true })
  ).rows);
  check('5.2 is info, not fail, when anonymous sharing is blocked', function () {
    assert.strictEqual(blocked['5.2'].status, 'info', blocked['5.2'].detail);
  });
  check('5.3 is info when anonymous sharing is blocked', function () {
    assert.strictEqual(blocked['5.3'].status, 'info');
  });
  check('5.10 is info when anonymous sharing is blocked', function () {
    assert.strictEqual(blocked['5.10'].status, 'info');
  });
  check('5.1 does not fail on excused anonymous links alone', function () {
    assert.notStrictEqual(blocked['5.1'].status, 'fail', blocked['5.1'].detail);
  });

  // Undeclared policy — a missing anonymous link is a failure like any other. This is the guard
  // that stops the exemption from being inferred rather than declared.
  const undeclared = byId(computeContentFunctionalityChecklist(
    baseDcv({ linkObservations: anonRows, anonymousBlocked: false })
  ).rows);
  check('NEGATIVE 5.2 still fails when the policy is not declared', function () {
    assert.strictEqual(undeclared['5.2'].status, 'fail');
  });
  check('NEGATIVE 5.1 still fails when the policy is not declared', function () {
    assert.strictEqual(undeclared['5.1'].status, 'fail');
  });

  // Organization rows are never excused by the anonymous policy — this is the real defect.
  const orgLost = byId(computeContentFunctionalityChecklist(baseDcv({
    linkObservations: [
      obs('anyone', 'reader', 'folder', false),
      obs('domain', 'writer', 'folder', false),
      obs('domain', 'reader', 'folder', true),
    ],
    anonymousBlocked: true,
  })).rows);
  check('5.8 organization edit still FAILS while anonymous is excused', function () {
    assert.strictEqual(orgLost['5.8'].status, 'fail', orgLost['5.8'].detail);
  });
  check('5.6 organization view still passes', function () {
    assert.strictEqual(orgLost['5.6'].status, 'pass');
  });
  check('5.1 fails on the organization loss, not the anonymous one', function () {
    assert.strictEqual(orgLost['5.1'].status, 'fail');
  });

  // Group permissions now register in the coverage report, so the "no GROUP permissions were
  // exercised" gap clears only when groups were genuinely compared.
  const withGroups = computeContentFunctionalityChecklist(baseDcv({
    permissionObservations: [
      { itemType: 'folder', role: 'reader', principalType: 'group', scope: 'subFolder', match: true, path: '/g' },
      { itemType: 'folder', role: 'reader', principalType: 'user', scope: 'subFolder', match: true, path: '/u' },
    ],
  }));
  check('exercised group grants clear the GROUP coverage gap', function () {
    assert.strictEqual(withGroups.coverage.groupsUntested, false);
  });
}

testClassification();
testGroupMatching();
testAnonymousExemption();
testChecklistExemption();


// ── 5. Over-limit paths are placeholders, never "Missing" ────────────────────
// The live run seeded a path 553 encoded characters long. SharePoint's limit is 400, so the
// destination creates a Folder/File Path Link URL instead — confirmed at the destination as
// FolderPathLink91.url. Check 11 and the structure comparison already treated that as expected,
// but the per-item rows and the PDF still printed three red "Missing" lines for it, contradicting
// check 11 on the same page.
function testPlaceholderNotMissing() {
  const SEG = 'L'.repeat(118);
  const PREFIX = '/Agent Shared Drive';
  const deepFolder = '/Over Limit Path/' + SEG + '1/' + SEG + '2/' + SEG + '3';
  const deepFile = deepFolder + '/over_limit_target.txt';

  // Self-check: the fixture really is over the limit, so the assertions below mean something.
  check('the fixture path genuinely exceeds the SharePoint limit', function () {
    assert.ok(
      core.encodedPathLength(PREFIX + deepFile) > 400,
      'encoded length was ' + core.encodedPathLength(PREFIX + deepFile)
    );
  });

  const folder = function (p) {
    return { path: p, name: p.split('/').pop(), type: 'folder', mimeType: 'application/vnd.google-apps.folder' };
  };
  const file = function (p) {
    return { path: p, name: p.split('/').pop(), type: 'file', mimeType: 'text/plain', size: 10 };
  };
  const source = [
    folder('/Over Limit Path'),
    folder('/Over Limit Path/' + SEG + '1'),
    folder('/Over Limit Path/' + SEG + '1/' + SEG + '2'),
    folder(deepFolder),
    file(deepFile),
  ];
  // The destination only got as deep as the limit allowed.
  const dest = [
    folder('/Over Limit Path'),
    folder('/Over Limit Path/' + SEG + '1'),
    folder('/Over Limit Path/' + SEG + '1/' + SEG + '2'),
  ];

  const cmp = core.compareTrees(source, dest, { destPrefix: PREFIX });
  const phPaths = new Set(cmp.placeholderLinks.map(function (p) { return p.path; }));

  check('the over-limit folder is a placeholder, not missing', function () {
    assert.ok(phPaths.has(deepFolder), 'not in placeholderLinks');
    assert.ok(
      !cmp.missing.some(function (m) { return m.path === deepFolder; }),
      'reported as missing'
    );
  });
  check('the over-limit file is a placeholder, not missing', function () {
    assert.ok(phPaths.has(deepFile), 'not in placeholderLinks');
    assert.ok(
      !cmp.missing.some(function (m) { return m.path === deepFile; }),
      'reported as missing'
    );
  });

  // The per-item flag the PDF reads: unpaired AND over the limit means placeholder.
  const flagFor = function (p) {
    return !cmp.matched.get(p) && phPaths.has(p);
  };
  check('the per-item row is flagged placeholder', function () {
    assert.strictEqual(flagFor(deepFile), true);
  });

  // The PDF tag decision, mirroring pdfGenerator. Three states, not two.
  const tagOf = function (it) {
    return it.found ? 'Found' : (it.placeholder ? 'Placeholder' : 'Missing');
  };
  check('the PDF prints Placeholder, not Missing', function () {
    assert.strictEqual(tagOf({ found: false, placeholder: true }), 'Placeholder');
  });
  check('NEGATIVE a genuinely absent item still prints Missing', function () {
    assert.strictEqual(tagOf({ found: false, placeholder: false }), 'Missing');
  });
  check('a paired item still prints Found', function () {
    assert.strictEqual(tagOf({ found: true, placeholder: false }), 'Found');
  });

  // NEGATIVE — a short path that is simply absent must stay a failure.
  const shortCmp = core.compareTrees([file('/Agent Files/gone.txt')], [], { destPrefix: PREFIX });
  check('NEGATIVE a within-limit absence is still missing', function () {
    assert.strictEqual(shortCmp.missing.length, 1);
    assert.strictEqual(shortCmp.placeholderLinks.length, 0);
  });
}

testPlaceholderNotMissing();

if (failures > 0) {
  console.error('contentGroupPermissions.test.js: ' + failures + ' check(s) failed');
  process.exit(1);
}
console.log('contentGroupPermissions.test.js: ok');
