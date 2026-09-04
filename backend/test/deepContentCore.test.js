/**
 * Run: npm test  (from backend/)
 *
 * Pure-function cover for the content validation engine. Feature numbers refer to
 * backend/data/feature-scope/google-shared-drive-to-sharepoint-inscope.md
 */
const assert = require('assert');
const core = require('../src/validation/shared/deepContentCore');

function file(path, name, extra = {}) {
  return { type: 'file', path, name, size: 100, mimeType: 'text/plain', ...extra };
}
function folder(path, name, extra = {}) {
  return { type: 'folder', path, name, ...extra };
}

function testSanitizing() {
  // Feature 7.1 — unsupported characters become _ or -
  assert.strictEqual(core.sanitizeForSharePoint('a:b*c?d', '_'), 'a_b_c_d');
  assert.strictEqual(core.sanitizeForSharePoint('a:b*c?d', '-'), 'a-b-c-d');
  assert.strictEqual(core.sanitizeForSharePoint('Report<2026>.pdf'), 'Report_2026_.pdf');
  // Case is preserved
  assert.strictEqual(core.sanitizeForSharePoint('MixedCase Name'), 'MixedCase Name');
  // Leading/trailing spaces are not allowed in SharePoint
  assert.strictEqual(core.sanitizeForSharePoint('  padded  '), 'padded');
  assert.strictEqual(core.needsSanitizing(' leading'), true);
  assert.strictEqual(core.needsSanitizing('trailing '), true);
  assert.strictEqual(core.needsSanitizing('clean name.pdf'), false);
  assert.strictEqual(core.needsSanitizing('has|pipe'), true);

  // Reserved names
  for (const reserved of ['CON', 'con', 'NUL', 'COM3', 'LPT9', '.lock', 'desktop.ini', 'forms']) {
    assert.strictEqual(core.isReservedName(reserved), true, `${reserved} is reserved`);
  }
  assert.strictEqual(core.isReservedName('~$draft.docx'), true, '~$ prefix is reserved');
  assert.strictEqual(core.isReservedName('my_vti_folder'), true, '_vti_ anywhere is reserved');
  assert.strictEqual(core.isReservedName('Quarterly Report'), false);
  assert.strictEqual(core.isReservedName('console.txt'), false, 'CON as a prefix is fine');
}

function testNameMatching() {
  assert.strictEqual(core.namesMatch('Report.pdf', 'Report.pdf'), true);
  assert.strictEqual(core.namesMatch('Report.pdf', 'report.pdf'), true, 'case-insensitive');
  // Either replacement character is accepted
  assert.strictEqual(core.namesMatch('a:b', 'a_b'), true);
  assert.strictEqual(core.namesMatch('a:b', 'a-b'), true);
  assert.strictEqual(core.namesMatch('a:b', 'a b'), false, 'a different rewrite is not a match');
  assert.strictEqual(core.namesMatch('Report.pdf', 'Summary.pdf'), false);
  assert.strictEqual(core.namesMatch('Report.pdf', ''), false);

  // Truncation of a very long name is accepted only past the 60-character threshold
  const long = 'L'.repeat(80);
  assert.strictEqual(core.namesMatch(long, long.slice(0, 70)), true);
  const short = 'S'.repeat(30);
  assert.strictEqual(core.namesMatch(short, short.slice(0, 20)), false, 'short names must match exactly');
}

function testConversion() {
  // Feature 12.1 — legacy Office upgrades
  assert.strictEqual(core.expectedDestExtension('report.doc'), '.docx');
  assert.strictEqual(core.expectedDestExtension('sheet.xls'), '.xlsx');
  assert.strictEqual(core.expectedDestExtension('deck.ppt'), '.pptx');
  // Pass-through formats are unchanged
  for (const ext of ['.pdf', '.txt', '.csv', '.xml', '.json', '.jpg', '.png', '.mp4', '.mp3', '.zip',
    '.rar', '.xlsm', '.docm', '.pptm', '.one', '.vsdx']) {
    assert.strictEqual(core.expectedDestExtension(`f${ext}`), ext, `${ext} passes through`);
  }
  // Google native exports
  assert.strictEqual(core.expectedDestExtension('Doc', 'application/vnd.google-apps.document'), '.docx');
  assert.strictEqual(core.expectedDestExtension('Sheet', 'application/vnd.google-apps.spreadsheet'), '.xlsx');
  assert.strictEqual(core.expectedDestExtension('Deck', 'application/vnd.google-apps.presentation'), '.pptx');

  // Full expected destination name: sanitized + converted
  assert.strictEqual(core.expectedDestName('report.doc'), 'report.docx');
  assert.strictEqual(core.expectedDestName('a:b.xls'), 'a_b.xlsx');
  assert.strictEqual(
    core.expectedDestName('Q1 Notes', 'application/vnd.google-apps.document'),
    'Q1 Notes.docx',
    'a native file gains its export extension'
  );
  assert.strictEqual(core.expectedDestName('plain.pdf'), 'plain.pdf');

  // Hashability: only byte-for-byte formats can be compared by hash
  assert.strictEqual(core.isHashable(file('/a.pdf', 'a.pdf', { mimeType: 'application/pdf' })), true);
  assert.strictEqual(core.isHashable(file('/a.doc', 'a.doc')), false, 'converted file is not hashable');
  assert.strictEqual(
    core.isHashable(file('/Doc', 'Doc', { mimeType: 'application/vnd.google-apps.document' })),
    false,
    'Google native file is not hashable'
  );
  assert.strictEqual(core.isHashable(folder('/f', 'f')), false, 'a folder has no content');
  assert.strictEqual(
    core.isHashable(file('/s', 's', { mimeType: 'application/vnd.google-apps.shortcut' })),
    false
  );
  // Every skip carries a reason, so it can never be read as a pass
  assert.ok(/cannot match/.test(core.notHashableReason(file('/a.doc', 'a.doc'))));
  assert.ok(/cannot match/.test(
    core.notHashableReason(file('/D', 'D', { mimeType: 'application/vnd.google-apps.document' }))
  ));
}

function testPathLimits() {
  // Feature 11.1 — the limit is measured on the URL-ENCODED path
  const plain = `/${'a'.repeat(398)}`;          // 399 encoded + leading slash accounted in helper
  assert.strictEqual(core.exceedsPathLimit(plain), false, '399 is inside the limit');
  assert.strictEqual(core.exceedsPathLimit(`/${'a'.repeat(399)}`), false, '400 is the limit itself');
  assert.strictEqual(core.exceedsPathLimit(`/${'a'.repeat(400)}`), true, '401 is over');

  // A path whose RAW length is inside the limit but whose ENCODED length is not: each space encodes
  // to %20, costing 3 characters instead of 1. 120 × "a b" = 360 raw, 600 encoded.
  const spacey = `/${'a b'.repeat(120)}`;
  assert.ok(spacey.length < 400, 'raw length is under the limit');
  assert.ok(core.encodedPathLength(spacey) > 400, 'encoded length is over the limit');
  assert.strictEqual(core.exceedsPathLimit(spacey), true, 'encoding must be counted');

  // Per-segment cap
  assert.deepStrictEqual(core.oversizedSegments('/short/also-short'), []);
  assert.strictEqual(core.oversizedSegments(`/${'x'.repeat(256)}`).length, 1);

  // The destination prefix counts toward the limit
  assert.strictEqual(core.expectPlaceholderLink('/a.txt', { prefix: '/root' }), false);
  assert.strictEqual(
    core.expectPlaceholderLink(`/${'a'.repeat(390)}.txt`, { prefix: `/${'p'.repeat(50)}` }),
    true,
    'prefix + path together cross the limit'
  );
}

function testCompareTrees() {
  const source = [folder('/Reports', 'Reports'), file('/Reports/Q1.pdf', 'Q1.pdf'),
    file('/Reports/Q2.pdf', 'Q2.pdf')];

  // Clean migration
  const clean = core.compareTrees(source, [
    folder('/Reports', 'Reports'), file('/Reports/Q1.pdf', 'Q1.pdf'), file('/Reports/Q2.pdf', 'Q2.pdf'),
  ]);
  assert.strictEqual(clean.status, 'PASS');
  assert.strictEqual(clean.matchedCount, 3);
  assert.deepStrictEqual(clean.missing, []);

  // A missing file must FAIL — the whole point of the validator
  const missing = core.compareTrees(source, [
    folder('/Reports', 'Reports'), file('/Reports/Q1.pdf', 'Q1.pdf'),
  ]);
  assert.strictEqual(missing.status, 'FAIL');
  assert.strictEqual(missing.missing.length, 1);
  assert.strictEqual(missing.missing[0].name, 'Q2.pdf');

  // An extra item on the destination is also a defect
  const extra = core.compareTrees(source, [
    folder('/Reports', 'Reports'), file('/Reports/Q1.pdf', 'Q1.pdf'),
    file('/Reports/Q2.pdf', 'Q2.pdf'), file('/Reports/temp.tmp', 'temp.tmp'),
  ]);
  assert.strictEqual(extra.status, 'FAIL');
  assert.strictEqual(extra.extra.length, 1);

  // Same name under a different parent = misplaced, not missing+extra
  const moved = core.compareTrees(source, [
    folder('/Reports', 'Reports'), file('/Reports/Q1.pdf', 'Q1.pdf'), file('/Q2.pdf', 'Q2.pdf'),
  ]);
  assert.strictEqual(moved.status, 'FAIL');
  assert.strictEqual(moved.misplaced.length, 1);
  assert.strictEqual(moved.misplaced[0].source, '/Reports/Q2.pdf');
  assert.strictEqual(moved.misplaced[0].dest, '/Q2.pdf');
  assert.strictEqual(moved.missing.length, 0, 'a moved item is not also counted missing');

  // Renaming is expected, not a difference
  const renamed = core.compareTrees(
    [file('/a:b.pdf', 'a:b.pdf')],
    [file('/a_b.pdf', 'a_b.pdf')]
  );
  assert.strictEqual(renamed.status, 'PASS', 'the SharePoint rename is the expected outcome');

  // Conversion is expected too
  const converted = core.compareTrees(
    [file('/old.doc', 'old.doc')],
    [file('/old.docx', 'old.docx')]
  );
  assert.strictEqual(converted.status, 'PASS', '.doc arriving as .docx is correct');

  // A RENAMED PARENT must not orphan its children. SharePoint renames folders as well as files, so
  // pairing on the literal parent path would report every file inside a renamed folder as misplaced.
  const renamedParent = core.compareTrees(
    [folder('/Special : Chars', 'Special : Chars'), file('/Special : Chars/report.pdf', 'report.pdf')],
    [folder('/Special _ Chars', 'Special _ Chars'), file('/Special _ Chars/report.pdf', 'report.pdf')]
  );
  assert.strictEqual(renamedParent.status, 'PASS', 'children of a renamed folder still pair');
  assert.strictEqual(renamedParent.misplaced.length, 0, 'and are not reported as moved');
  assert.strictEqual(renamedParent.matchedCount, 2);

  // The same holds two levels down, and with the other replacement character
  const deepRenamed = core.compareTrees(
    [folder('/A:B', 'A:B'), folder('/A:B/C?D', 'C?D'), file('/A:B/C?D/f.pdf', 'f.pdf')],
    [folder('/A-B', 'A-B'), folder('/A-B/C-D', 'C-D'), file('/A-B/C-D/f.pdf', 'f.pdf')]
  );
  assert.strictEqual(deepRenamed.status, 'PASS', 'nested renamed folders still pair');
  assert.strictEqual(deepRenamed.matchedCount, 3);

  // A genuinely moved file is STILL caught when the parent rename is accounted for
  const reallyMoved = core.compareTrees(
    [folder('/A:B', 'A:B'), file('/A:B/f.pdf', 'f.pdf')],
    [folder('/A_B', 'A_B'), file('/f.pdf', 'f.pdf')]
  );
  assert.strictEqual(reallyMoved.status, 'FAIL');
  assert.strictEqual(reallyMoved.misplaced.length, 1, 'a real move is not masked by the rename rule');

  // A moved item renamed with the OTHER replacement character is still reported as MOVED, not missing
  const movedAndRenamed = core.compareTrees(
    [folder('/A:B', 'A:B'), file('/A:B/f.pdf', 'f.pdf')],
    [folder('/A-B', 'A-B'), file('/f.pdf', 'f.pdf')]
  );
  assert.strictEqual(movedAndRenamed.misplaced.length, 1, 'a moved+renamed item is misplaced');
  assert.strictEqual(movedAndRenamed.missing.length, 0, 'not missing');

  // Feature 11.1 — an over-limit item is absent by design: placeholder, not missing, and not a FAIL
  const longName = 'L'.repeat(300);
  const overLimit = core.compareTrees(
    [file(`/${longName}/${longName}.pdf`, `${longName}.pdf`)],
    [],
    { destPrefix: '/dest' }
  );
  assert.strictEqual(overLimit.placeholderLinks.length, 1, 'routed to placeholderLinks');
  assert.strictEqual(overLimit.missing.length, 0, 'not counted as missing');
  assert.strictEqual(overLimit.status, 'PASS', 'the documented placeholder outcome does not fail a run');
}

function testCompareFolders() {
  const src = [folder('/A', 'A'), folder('/A/B', 'B'), file('/A/f.txt', 'f.txt')];
  const dst = [folder('/A', 'A'), folder('/A/B', 'B')];
  const res = core.compareFolders(src, dst);
  assert.strictEqual(res.totalSource, 2, 'files are excluded from the folder-only comparison');
  assert.strictEqual(res.status, 'PASS');
  assert.deepStrictEqual(res.sourceFolderPaths, ['/A', '/A/B']);

  const broken = core.compareFolders(src, [folder('/A', 'A')]);
  assert.strictEqual(broken.status, 'FAIL');
  assert.deepStrictEqual(broken.missing, ['/A/B']);
}

function testVersionsAreInformational() {
  // Out of scope: the Google API merges revisions, so fewer versions on the destination is expected
  const fewer = core.compareVersions(7, 3);
  assert.strictEqual(fewer.severity, 'INFO', 'never a failure verdict');
  assert.ok(/merges smaller revisions/.test(fewer.note), 'the reason is reported');

  const more = core.compareVersions(3, 6);
  assert.strictEqual(more.severity, 'INFO');
  assert.ok(/migration timestamp/.test(more.note));

  assert.strictEqual(core.compareVersions(5, 5).severity, 'INFO');
  assert.ok(/versioning is enabled/.test(core.compareVersions(4, 0).note));
}

function testTimestampsAndSize() {
  const drift = 5 * 60 * 1000;
  const base = '2026-08-20T10:00:00.000Z';
  const inBand = '2026-08-20T10:04:00.000Z';
  const outOfBand = '2026-08-20T10:30:00.000Z';

  assert.strictEqual(
    core.compareTimestamps({ modifiedAt: base }, { modifiedAt: inBand }, drift).match, true
  );
  assert.strictEqual(
    core.compareTimestamps({ modifiedAt: base }, { modifiedAt: outOfBand }, drift).match, false
  );
  assert.strictEqual(core.compareTimestamps({}, {}, drift).comparable, false);

  const bands = {
    fileSize: { infoMin: 0.99, infoMax: 1.01, warnMin: 0.95, warnMax: 1.05 },
    convertedFileSize: { infoMin: 0.25, infoMax: 4.0, warnMin: 0.05, warnMax: 20.0 },
  };
  const pdf = { type: 'file', name: 'a.pdf', size: 1000, mimeType: 'application/pdf' };
  assert.strictEqual(core.compareSize(pdf, { size: 1000 }, bands).status, 'PASS');
  assert.strictEqual(core.compareSize(pdf, { size: 1040 }, bands).status, 'WARN');
  assert.strictEqual(core.compareSize(pdf, { size: 5000 }, bands).status, 'FAIL');
  // A converted file uses the wider band, so the same ratio is acceptable.
  //
  // Sized ABOVE the 10 KB floor on purpose. Below it a converted file is reported as not
  // comparable rather than scored, because the destination format's fixed zip/XML overhead
  // dominates a small file and the ratio stops meaning anything — a 1 KB Google Doc exporting to
  // 14 KB is a correct conversion, not a 14x defect. This assertion is about BAND SELECTION, so it
  // uses a size where the band still applies.
  const doc = { type: 'file', name: 'a.doc', size: 100000 };
  assert.strictEqual(core.compareSize(doc, { size: 250000 }, bands).status, 'PASS',
    'a 2.5x growth on a large converted file is inside the converted band');

  // And the floor itself: the same ratio on a small converted file is reported, not scored.
  const smallDoc = { type: 'file', name: 'b.doc', size: 1000 };
  const floored = core.compareSize(smallDoc, { size: 2500 }, bands);
  assert.strictEqual(floored.comparable, false,
    'a 1000-byte converted file is below the floor where a ratio is meaningful');
  assert.strictEqual(floored.status, 'INFO', 'so it is reported at INFO, never scored');

  // A small PASSTHROUGH file is unaffected — no converter overhead applies to it.
  const smallPdf = { type: 'file', name: 'b.pdf', size: 1000, mimeType: 'application/pdf' };
  assert.strictEqual(core.compareSize(smallPdf, { size: 2500 }, bands).status, 'FAIL',
    'passthrough bytes must still match at any size');
}

function testRunShape() {
  const map = core.buildEmailMap({
    userEmailMappings: [{ sourceEmail: 'A@src.com', destinationEmail: 'A@dst.com' }],
    migratedUsers: [{ sourceEmail: 'b@src.com', destinationEmail: 'b@dst.com' }],
    permissionMapping: [{ fromMailId: 'c@src.com', toMailId: 'c@dst.com' }],
  });
  assert.strictEqual(map['a@src.com'], 'a@dst.com', 'lower-cased on both sides');
  assert.strictEqual(map['b@src.com'], 'b@dst.com');
  assert.strictEqual(map['c@src.com'], 'c@dst.com');

  // migratedUsers wins, then userFolderMappings, then the single-pair fallback
  assert.strictEqual(core.resolveUnits({ migratedUsers: [{ sourceEmail: 'x@s' }] }).length, 1);
  assert.strictEqual(
    core.resolveUnits({ userFolderMappings: [{ sourceEmail: 'x@s' }, { sourceEmail: 'y@s' }] }).length, 2
  );
  const fallback = core.resolveUnits({ sourceEmail: 'one@s', destinationPath: '/D' });
  assert.strictEqual(fallback.length, 1);
  assert.strictEqual(fallback[0].destinationPath, '/D');
}

function testPathHelpers() {
  assert.strictEqual(core.joinPath('/a', 'b'), '/a/b');
  assert.strictEqual(core.joinPath('/', 'b'), '/b');
  assert.strictEqual(core.parentOf('/a/b/c'), '/a/b');
  assert.strictEqual(core.parentOf('/a'), '/');
  assert.strictEqual(core.lastSegment('/a/b/c.txt'), 'c.txt');
  // The Graph default drive IS the Documents library, so everything up to it collapses to the root
  assert.strictEqual(core.inDrivePath('/SANITY DATAA/Documents'), '/');
  assert.strictEqual(core.inDrivePath('/SANITY DATAA/Documents/Sub'), '/Sub');
  // …which is exactly why the site segment has to be read separately: inDrivePath discards it, and
  // validating SHAREPOINT_SITE_PATH instead of the site the data went to compares the wrong place.
  assert.strictEqual(core.siteSegmentOf('/SANITY DATAA/Documents'), 'SANITY DATAA');
  assert.strictEqual(core.siteSegmentOf('/SANITY DATAA/Documents/Sub'), 'SANITY DATAA');
  assert.strictEqual(core.siteSegmentOf('/Documents/Sub'), null, 'no site segment when the path starts at the library');
  assert.strictEqual(core.siteSegmentOf('/Sub'), null);
  assert.strictEqual(core.siteSegmentOf('/'), null);
  assert.strictEqual(core.siteSegmentOf(''), null);
  assert.deepStrictEqual(
    core.relativize([{ path: '/root/a', name: 'a' }], '/root'),
    [{ path: '/a', name: 'a' }]
  );
}

function testComparePermissions() {
  const mapEmail = (e) => String(e || '').toLowerCase().replace('@src.com', '@dst.com');

  // Correct mapping passes
  const ok = core.comparePermissions(
    [{ email: 'a@src.com', role: 'writer' }, { email: 'b@src.com', role: 'reader' }],
    [{ email: 'a@dst.com', roles: ['write'] }, { email: 'b@dst.com', roles: ['read'] }],
    mapEmail
  );
  assert.strictEqual(ok.checked, 2);
  assert.strictEqual(ok.mismatches.length, 0);
  assert.strictEqual(ok.escalations.length, 0);

  // A Contributor downgraded to read-only is a mismatch
  const downgraded = core.comparePermissions(
    [{ email: 'a@src.com', role: 'writer' }],
    [{ email: 'a@dst.com', roles: ['read'] }],
    mapEmail
  );
  assert.strictEqual(downgraded.mismatches.length, 1);
  assert.strictEqual(downgraded.mismatches[0].expected, 'Edit');

  // A user missing entirely on the destination is a mismatch, not a skip
  const absent = core.comparePermissions(
    [{ email: 'a@src.com', role: 'reader' }], [], mapEmail
  );
  assert.strictEqual(absent.mismatches.length, 1);

  // A Commenter granted edit is surfaced as an escalation
  const escalated = core.comparePermissions(
    [{ email: 'a@src.com', role: 'commenter' }],
    [{ email: 'a@dst.com', roles: ['write'] }],
    mapEmail
  );
  assert.strictEqual(escalated.escalations.length, 1);
  assert.strictEqual(escalated.mismatches.length, 0, 'at-least semantics keep it out of mismatches');

  // Entries without an email are ignored rather than counted
  assert.strictEqual(core.comparePermissions([{ role: 'reader' }], [], mapEmail).checked, 0);
}

/**
 * Group permissions are the majority of the manual QA suite's cases for this combination, including
 * "internal user should be in group" — where a person's access arrives through a group.
 */
function testGroupPermissions() {
  const mapEmail = (e) => String(e || '').toLowerCase().replace('@src.com', '@dst.com');

  // A group grant preserved as a group grant
  const groupOk = core.comparePermissions(
    [{ email: 'team@src.com', role: 'writer', type: 'group' }],
    [{ email: 'team@dst.com', roles: ['write'], principalType: 'group' }],
    mapEmail
  );
  assert.strictEqual(groupOk.mismatches.length, 0);
  assert.strictEqual(groupOk.matches[0].principalType, 'group', 'the principal type is recorded');

  // A group grant that lost access still fails
  const groupGone = core.comparePermissions(
    [{ email: 'team@src.com', role: 'writer', type: 'group' }], [], mapEmail
  );
  assert.strictEqual(groupGone.mismatches.length, 1);

  // The important case: the user has no direct grant, but a group on the item carries the access.
  // SharePoint shows the group, not the person — failing this would fail a CORRECT migration.
  const viaGroup = core.comparePermissions(
    [{ email: 'alice@src.com', role: 'reader', type: 'user' }],
    [{ email: 'team@dst.com', roles: ['read'], principalType: 'group' }],
    mapEmail
  );
  assert.strictEqual(viaGroup.mismatches.length, 0, 'access via a group is not a mismatch');
  assert.strictEqual(viaGroup.viaGroup.length, 1, 'but it is reported, not silently passed');
  assert.ok(/verify the user is a member/.test(viaGroup.viaGroup[0].note));

  // The fallback does not paper over a genuine downgrade: a writer cannot be covered by a
  // read-only group.
  const insufficientGroup = core.comparePermissions(
    [{ email: 'alice@src.com', role: 'writer', type: 'user' }],
    [{ email: 'team@dst.com', roles: ['read'], principalType: 'group' }],
    mapEmail
  );
  assert.strictEqual(insufficientGroup.mismatches.length, 1, 'a read-only group cannot cover an editor');
  assert.strictEqual(insufficientGroup.viaGroup.length, 0);

  // A user grant is never rescued by another USER's grant
  const otherUser = core.comparePermissions(
    [{ email: 'alice@src.com', role: 'reader', type: 'user' }],
    [{ email: 'bob@dst.com', roles: ['write'], principalType: 'user' }],
    mapEmail
  );
  assert.strictEqual(otherUser.mismatches.length, 1);
}

/** The QA suite reports permissions by item scope, so scopeOf must classify the way it does. */
/**
 * A source role with no comparable destination permission must be REPORTED, not failed.
 * Drive returns an `owner` grant for every My Drive file, so treating it as an ordinary grant
 * failed every My Drive run on its own owner permission.
 */
function testNonComparableRoles() {
  const mapEmail = (e) => String(e || '').toLowerCase().replace('@src.com', '@dst.com');

  const withOwner = core.comparePermissions(
    [
      { email: 'me@src.com', role: 'owner', type: 'user' },
      { email: 'bob@src.com', role: 'writer', type: 'user' },
    ],
    [{ email: 'bob@dst.com', roles: ['write'], principalType: 'user' }],
    mapEmail
  );
  assert.strictEqual(withOwner.mismatches.length, 0, 'the owner grant must not fail the run');
  assert.strictEqual(withOwner.notComparable.length, 1, 'it is reported instead');
  assert.ok(/ownership is not a shareable permission/.test(withOwner.notComparable[0].reason));
  assert.strictEqual(withOwner.checked, 1, 'only the comparable grant counts as checked');

  // An unrecognised role is also reported rather than failed
  const unknown = core.comparePermissions(
    [{ email: 'x@src.com', role: 'someNewRole', type: 'user' }], [], mapEmail
  );
  assert.strictEqual(unknown.mismatches.length, 0);
  assert.strictEqual(unknown.notComparable.length, 1);
  assert.ok(/unrecognised Drive role/.test(unknown.notComparable[0].reason));

  // Manager (organizer) expects Edit, not Full Control — the doc only promises "closest equivalent",
  // so a correctly-mapped Manager→Edit grant must pass.
  const manager = core.comparePermissions(
    [{ email: 'm@src.com', role: 'organizer', type: 'user' }],
    [{ email: 'm@dst.com', roles: ['write'], principalType: 'user' }],
    mapEmail
  );
  assert.strictEqual(manager.mismatches.length, 0, 'Manager → Edit is acceptable');
  // Full Control also satisfies it (at-least semantics)
  const managerFull = core.comparePermissions(
    [{ email: 'm@src.com', role: 'organizer', type: 'user' }],
    [{ email: 'm@dst.com', roles: ['full control'], principalType: 'user' }],
    mapEmail
  );
  assert.strictEqual(managerFull.mismatches.length, 0);
  // But losing the access entirely still fails
  const managerGone = core.comparePermissions(
    [{ email: 'm@src.com', role: 'organizer', type: 'user' }], [], mapEmail
  );
  assert.strictEqual(managerGone.mismatches.length, 1);
}

/** Truncation is one-directional: only the DESTINATION gets shortened. */
function testTruncationIsAnchored() {
  const longA = `${'A'.repeat(70)}-alpha`;
  const longB = `${'A'.repeat(70)}-beta`;

  // A genuinely truncated destination still pairs
  assert.strictEqual(core.namesMatch(longA, longA.slice(0, 65)), true);
  // Two long SOURCE names sharing a 70-char prefix must NOT pair with each other
  assert.strictEqual(core.namesMatch(longA, longB), false,
    'a shared prefix is not a match when neither side is truncated');
  // A destination LONGER than the source is not a truncation
  assert.strictEqual(core.namesMatch(longA.slice(0, 65), longA), false);
}

function testScopeOf() {
  assert.strictEqual(core.scopeOf({ path: '/Reports', type: 'folder' }), 'rootFolder');
  assert.strictEqual(core.scopeOf({ path: '/readme.txt', type: 'file' }), 'rootFile');
  assert.strictEqual(core.scopeOf({ path: '/Reports/Q1', type: 'folder' }), 'subFolder');
  assert.strictEqual(core.scopeOf({ path: '/Reports/Q1.pdf', type: 'file' }), 'innerFile');
  assert.strictEqual(core.scopeOf({ path: '/Reports/Q1/deep/x.pdf', type: 'file' }), 'innerFile');
  assert.strictEqual(core.scopeOf({ path: '/', type: 'folder' }), 'root');
  assert.ok(core.SCOPE_LABEL.subFolder);
}

function testCompareSharedLinks() {
  // Anonymous view link preserved
  const ok = core.compareSharedLinks(
    [{ type: 'anyone', role: 'reader' }],
    [{ scope: 'anonymous', type: 'view' }]
  );
  assert.strictEqual(ok.checked, 1);
  assert.strictEqual(ok.mismatches.length, 0);

  // Public link silently narrowed to the organization — the defect a presence-only check misses
  const narrowed = core.compareSharedLinks(
    [{ type: 'anyone', role: 'reader' }],
    [{ scope: 'organization', type: 'view' }]
  );
  assert.strictEqual(narrowed.mismatches.length, 1);
  assert.ok(/no anonymous link/.test(narrowed.mismatches[0].reason));

  // Right audience, wrong power
  const wrongPower = core.compareSharedLinks(
    [{ type: 'domain', role: 'writer' }],
    [{ scope: 'organization', type: 'view' }]
  );
  assert.strictEqual(wrongPower.mismatches.length, 1);
  assert.ok(/scope preserved but type/.test(wrongPower.mismatches[0].reason));

  // No link at all
  const gone = core.compareSharedLinks([{ type: 'anyone', role: 'writer' }], []);
  assert.strictEqual(gone.mismatches.length, 1);
  assert.strictEqual(gone.results[0].actual, 'no link on destination');

  // Multiple links on the destination: the right one only needs to exist among them
  const multi = core.compareSharedLinks(
    [{ type: 'anyone', role: 'writer' }],
    [{ scope: 'organization', type: 'view' }, { scope: 'anonymous', type: 'edit' }]
  );
  assert.strictEqual(multi.mismatches.length, 0);

  assert.strictEqual(core.compareSharedLinks([], []).checked, 0);
}

async function testTierBHashes() {
  const bin = (p, n) => ({ type: 'file', path: p, name: n, mimeType: 'application/pdf' });
  const pairs = (arr) => arr.map((s) => ({ source: s, dest: { ...s } }));

  // Identical bytes pass
  const same = await core.tierBHashes(
    pairs([bin('/a.pdf', 'a.pdf')]),
    async () => Buffer.from('hello world'),
    async () => Buffer.from('hello world')
  );
  assert.strictEqual(same.scanned, 1);
  assert.strictEqual(same.mismatches.length, 0);
  assert.strictEqual(same.hashed.length, 1);

  // Different bytes fail, and the byte counts are reported
  const differs = await core.tierBHashes(
    pairs([bin('/a.pdf', 'a.pdf')]),
    async () => Buffer.from('hello world'),
    async () => Buffer.from('hello'),
  );
  assert.strictEqual(differs.mismatches.length, 1);
  assert.strictEqual(differs.mismatches[0].sourceBytes, 11);
  assert.strictEqual(differs.mismatches[0].destBytes, 5);

  // Converted and native files are never hashed, and carry a reason
  const skipped = await core.tierBHashes(
    pairs([
      { type: 'file', path: '/x.doc', name: 'x.doc' },
      { type: 'file', path: '/D', name: 'D', mimeType: 'application/vnd.google-apps.document' },
      { type: 'folder', path: '/f', name: 'f' },
    ]),
    async () => { throw new Error('should never download a converted file'); },
    async () => { throw new Error('should never download a converted file'); }
  );
  assert.strictEqual(skipped.scanned, 0, 'no downloads attempted');
  assert.strictEqual(skipped.hashed.length, 0, 'and nothing counted as hashed');
  assert.strictEqual(skipped.notHashed.length, 2, 'the two files are reported; the folder is ignored');
  assert.ok(skipped.notHashed.every((n) => n.reason));

  // The cap is honoured, and capped files are reported rather than dropped
  const capped = await core.tierBHashes(
    pairs([bin('/1.pdf', '1.pdf'), bin('/2.pdf', '2.pdf'), bin('/3.pdf', '3.pdf')]),
    async () => Buffer.from('x'),
    async () => Buffer.from('x'),
    { maxFiles: 2 }
  );
  assert.strictEqual(capped.scanned, 2);
  assert.strictEqual(capped.notHashed.length, 1);
  assert.ok(/cap/.test(capped.notHashed[0].reason));

  // A read failure is a reported skip, not a silent pass and not a thrown run
  const failed = await core.tierBHashes(
    pairs([bin('/a.pdf', 'a.pdf')]),
    async () => { throw new Error('403 forbidden'); },
    async () => Buffer.from('x')
  );
  assert.strictEqual(failed.hashed.length, 0, 'a failed read is never counted as a pass');
  assert.strictEqual(failed.notHashed.length, 1);
  assert.ok(/content read failed/.test(failed.notHashed[0].reason));
}

function run() {
  testSanitizing();
  testNameMatching();
  testConversion();
  testPathLimits();
  testCompareTrees();
  testCompareFolders();
  testVersionsAreInformational();
  testTimestampsAndSize();
  testRunShape();
  testPathHelpers();
  testComparePermissions();
  testGroupPermissions();
  testNonComparableRoles();
  testTruncationIsAnchored();
  testScopeOf();
  testCompareSharedLinks();
}

// tierBHashes is async, so the run finishes in a promise chain.
run();
testTierBHashes()
  .then(() => console.log('deepContentCore.test.js: ok'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
