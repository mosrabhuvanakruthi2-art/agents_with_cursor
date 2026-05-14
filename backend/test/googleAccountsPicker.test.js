/**
 * Run: npm test  (from backend/)
 */
const assert = require('assert');
const {
  pickCorrespondentEmail,
  pickCcEmail,
  pickBccEmail,
  buildInboundSenderRotation,
  pickRotatedSender,
} = require('../src/utils/googleAccountsPicker');

function run() {
  const two = new Map([
    ['peter@cloudfuze.us', 't1'],
    ['other@cloudfuze.us', 't2'],
  ]);
  assert.strictEqual(pickCorrespondentEmail(two, 'peter@cloudfuze.us'), 'other@cloudfuze.us');
  assert.strictEqual(pickCorrespondentEmail(two, 'OTHER@cloudfuze.us'), 'peter@cloudfuze.us');
  assert.strictEqual(pickCorrespondentEmail(two, 'peter@cloudfuze.us'), 'other@cloudfuze.us');

  assert.strictEqual(pickCcEmail(two, 'peter@cloudfuze.us', 'other@cloudfuze.us'), 'peter@cloudfuze.us');
  assert.strictEqual(pickCcEmail(two, 'peter@cloudfuze.us', 'peter@cloudfuze.us'), 'other@cloudfuze.us');

  const three = new Map([
    ['a@x.com', '1'],
    ['b@x.com', '2'],
    ['c@x.com', '3'],
  ]);
  const cc3 = pickCcEmail(three, 'a@x.com', 'b@x.com');
  assert.strictEqual(cc3, 'c@x.com', 'Cc should be the only address that is neither source nor To');

  const altFromThree = pickCorrespondentEmail(three, 'a@x.com');
  assert.strictEqual(altFromThree, 'b@x.com', 'Deterministic pick among sorted alternates');

  const single = new Map([['only@x.com', 't']]);
  assert.strictEqual(pickCorrespondentEmail(single, 'only@x.com'), 'only@x.com');
  assert.strictEqual(pickCcEmail(single, 'only@x.com', 'only@x.com'), 'only@x.com');

  assert.strictEqual(pickCorrespondentEmail(new Map(), 'a@b.com'), 'a@b.com');

  // Bcc picker — must be distinct from source / To / Cc when possible.
  const four = new Map([
    ['peter@cloudfuze.us', '1'],
    ['granger@cloudfuze.us', '2'],
    ['dan@cloudfuze.us', '3'],
    ['alex@cloudfuze.us', '4'],
  ]);
  const bcc4 = pickBccEmail(four, 'peter@cloudfuze.us', 'dan@cloudfuze.us', 'granger@cloudfuze.us');
  assert.ok(
    !['peter@cloudfuze.us', 'dan@cloudfuze.us', 'granger@cloudfuze.us'].includes(bcc4),
    `Bcc (${bcc4}) must not equal source/To/Cc when 4+ accounts exist`
  );
  assert.strictEqual(bcc4, 'alex@cloudfuze.us', 'Bcc is the remaining distinct user');

  const bcc3 = pickBccEmail(three, 'a@x.com', 'b@x.com', 'c@x.com');
  assert.notStrictEqual(bcc3, 'a@x.com', 'Bcc must not equal source');
  assert.ok(['b@x.com', 'c@x.com'].includes(bcc3), 'Bcc falls back to non-source account');

  const bccTwo = pickBccEmail(two, 'peter@cloudfuze.us', 'other@cloudfuze.us', 'other@cloudfuze.us');
  assert.strictEqual(bccTwo, 'other@cloudfuze.us', 'Bcc falls back to only other account');

  assert.strictEqual(
    pickBccEmail(single, 'only@x.com', 'only@x.com', 'only@x.com'),
    'only@x.com',
    'Bcc falls back to source as absolute last resort when only one account exists'
  );

  // Inbound sender rotation — excludes source, sorted, cycles deterministically.
  const eight = new Map([
    ['granger@cloudfuze.us', 't1'],
    ['alex@cloudfuze.us', 't2'],
    ['austin@cloudfuze.us', 't3'],
    ['dan@cloudfuze.us', 't4'],
    ['harry@cloudfuze.us', 't5'],
    ['peter@cloudfuze.us', 't6'],
    ['sonia@cloudfuze.us', 't7'],
    ['zara@storefuze.com', 't8'],
  ]);
  const rot = buildInboundSenderRotation(eight, 'peter@cloudfuze.us');
  assert.strictEqual(rot.length, 7, 'rotation excludes source');
  assert.ok(!rot.includes('peter@cloudfuze.us'), 'rotation excludes source address');
  // Sorted lowercase
  const sorted = [...rot].sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(rot, sorted, 'rotation is sorted');
  // Array input also supported
  const rotArr = buildInboundSenderRotation(['granger@gajha.com', 'peter@cloudfuze.us', 'dan@gajha.com'], 'peter@cloudfuze.us');
  assert.deepStrictEqual(rotArr, ['dan@gajha.com', 'granger@gajha.com']);
  // Deterministic pick for same source+index
  const pickA1 = pickRotatedSender(rot, 'peter@cloudfuze.us', 0);
  const pickA2 = pickRotatedSender(rot, 'peter@cloudfuze.us', 0);
  assert.strictEqual(pickA1, pickA2, 'pickRotatedSender is deterministic');
  // Single-account fallback
  assert.strictEqual(pickRotatedSender([], 'peter@cloudfuze.us', 3), 'peter@cloudfuze.us');

  console.log('googleAccountsPicker.test.js: ok');
}

run();
